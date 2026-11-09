// Conformance: traps (engine map: Physics > Traps). The trap hit events the engine raises when a
// trap's body touches an actor (OnTrapHitStart, OnTrapHit, OnTrapHitStop: 14 vanilla scripts
// handle them), over every trap of the load order. Skipped without game data.
//
// Sources:
// - The engine's rule, observed in the original (src/scripting/runtime/trap-hits.ts): each physics world
//   has a trap listener; bodies on L_TRAP and L_CLOUDTRAP are traps, a character controller's
//   contact with one is a hit. A new contact tells the start, a lasting one a hit once more than
//   [Havok] fTrapHitEventDelayMS (500 ms) has passed since the last telling, its end the stop
//   (TESTrapHitEvent); the scripts hear them only on living actors.
// - The base scripts' declarations (`node tools/script-events.ts OnTrapHit`): OnTrapHitStart,
//   OnTrapHit (akTarget, the velocity, the position, aeMaterial, abInitialHit, aeMotionType),
//   OnTrapHitStop (akTarget).
// - The data (Skyrim.esm): TrapSpear01 [0005B8F4] (TrapHitBase; its spear SpikeTrap, a fixed body
//   on L_TRAP up to 388 units over its origin: `node tools/collision-info.ts
//   meshes/traps/spiketrap/spiketrap01.nif`); one of them, [00050C22], stands in
//   RiftenMercerFreyHouse [00037CC6] at (−2371.1, 2148.9, −814.6). The plate [00050C2B] beside it
//   (PressurePlate) is the activate parent of it and three more. In WarehouseTraps [000243DF] the
//   tripwire [000247B8] is the activate parent of the battering ram [0002464C], a log that swings
//   (TrapBatteringRam01: BatteringTrap, TrapHitBase).
// - The scripts: PressurePlate and TrapTriggerBase's plain triggers go off in the state they enter
//   on the first step (Inactive's OnTriggerEnter goes to active, whose onBeginState activates).
//   dunKarthspirePlatePuzzleSCRIPT, MQ203's 69 plates alone, casts in its Active state's
//   OnTriggerEnter instead (see the plates' test in tests/sim-alduins-wall.int.test.ts).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { EXPLOSION_DEFAULTS, gameplayImpulse } from '../../../src/gameplay/magic/explosions.ts';
import { arrowKnock } from '../../../src/gameplay/impulses.ts';
import { parseVmad } from '../../../src/formats/esm/vmad.ts';
import { parseNif } from '../../../src/formats/nif/nif.ts';
import {
  buildCollision,
  HAVOK_SCALE,
  type CollisionData,
} from '../../../src/physics/collision-data.ts';
import { CollisionMatrix as Matrix, Layer } from '../../../src/physics/collision-layers.ts';
import { ActivatorKeywords } from '../../../src/scripting/runtime/activator-keywords.ts';
import { ActorValue } from '../../../src/world/actor-values.ts';
import {
  GRAVITY,
  initPhysics,
  PhysicsWorld,
  type PlacedCollision,
} from '../../../src/physics/physics-world.ts';
import { EventHub, type GameEvents } from '../../../src/scripting/runtime/event-hub.ts';
import {
  TRAP_HIT_EVENT_DELAY_MS,
  TrapHits,
  type TrapTouchNow,
} from '../../../src/scripting/runtime/trap-hits.ts';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { RecordDatabase } from '../../../src/world/record-db.ts';
import { openGameFolder } from '../../../tools/gamedata-path.ts';
import { scriptEventUsage } from '../../../tools/script-event-usage.ts';
import { worldRulesCensus, type WorldRulesCensus } from '../../../tools/world-rules-census.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

const TOUCH: TrapTouchNow = { position: [1, 2, 3], velocity: [0, 0, -50], motionType: 4 };

describe('trap contacts (the engine’s rule)', () => {
  const setup = () => {
    const hub = new EventHub();
    const told: GameEvents['trapHit'][] = [];
    hub.on('trapHit', (event) => {
      told.push(event);
    });
    let now = 0;
    const hits = new TrapHits(hub, () => now);
    return { hits, told, at: (ms: number) => (now = ms) };
  };

  it('tells the start as a trap first touches an actor', () => {
    const { hits, told } = setup();
    hits.touching(20, new Map([[7, TOUCH]]));
    expect(told).toEqual([
      {
        trap: 7,
        phase: 'start',
        target: 20,
        velocity: [0, 0, -50],
        position: [1, 2, 3],
        material: undefined,
        initial: false,
        motionType: 4,
      },
    ]);
  });

  it('tells a hit once more than fTrapHitEventDelayMS (500 ms) has passed, then again', () => {
    const { hits, told, at } = setup();
    const touching = new Map([[7, TOUCH]]);
    hits.touching(20, touching);
    for (const ms of [100, 400, 500, 501, 900, 1002]) {
      at(ms);
      hits.touching(20, touching);
    }
    expect(told.map((event) => event.phase)).toEqual(['start', 'hit', 'hit']);
    expect(TRAP_HIT_EVENT_DELAY_MS).toBe(500);
  });

  it('tells the stop as the contact ends, and nothing after', () => {
    const { hits, told } = setup();
    hits.touching(20, new Map([[7, TOUCH]]));
    hits.touching(20, new Map());
    hits.touching(20, new Map());
    expect(told.map((event) => event.phase)).toEqual(['start', 'stop']);
  });

  it('keeps an entry per trap and target', () => {
    const { hits, told } = setup();
    hits.touching(20, new Map([[7, TOUCH]]));
    hits.touching(21, new Map([[7, TOUCH]]));
    hits.touching(
      20,
      new Map([
        [7, TOUCH],
        [8, TOUCH],
      ]),
    );
    expect(told.map((event) => `${String(event.trap)}>${String(event.target)}`)).toEqual([
      '7>20',
      '7>21',
      '8>20',
    ]);
  });
});

describe.skipIf(!hasGamedata())('the traps of the load order (data)', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let census: WorldRulesCensus;
  let handlers: ReadonlyMap<string, readonly string[]>;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    census = await worldRulesCensus(vfs, db);
    handlers = (await scriptEventUsage(vfs)).handlers;
  }, 300_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it('counts the scripts that handle the trap hit events (8, 6, 0)', () => {
    expect(handlers.get('ontraphit')?.length).toBe(8);
    expect(handlers.get('ontraphitstart')?.length).toBe(6);
    expect(handlers.get('ontraphitstop')?.length ?? 0).toBe(0);
  });

  it('counts the trap-hit scripts and the 28 bases and 1,797 references that carry them', () => {
    expect([...census.trapHitScripts].sort()).toEqual([
      'bladetraphit',
      'ccbgs_arspiketrapscript',
      'hazardbase',
      'physicstraphit',
      'trapdweflamepillarhit',
      'trapdwethresherhit',
      'traphitbase',
    ]);
    expect(census.trapBases).toBe(28);
    expect(census.trapReferences).toBe(1797);
  });

  it('counts the pressure plates by the state their traps go off from (419 at the first step, 69 not)', async () => {
    const plates = ['pressureplate', 'dunkarthspireplatepuzzlescript'];
    const bases = new Map<number, string>();
    for (const formId of db.formIdsOfType('ACTI')) {
      const record = await db.get(formId);
      const vmad = record?.fields.first('VMAD');
      if (!record || !vmad) continue;
      for (const { name } of parseVmad(vmad, record.type).scripts) {
        if (plates.includes(name.toLowerCase())) bases.set(formId, name.toLowerCase());
      }
    }
    const count = new Map<string, number>();
    await db.scan(
      ['REFR'],
      () => true,
      (record) => {
        const base = record.formIdField('NAME');
        const script = !record.deleted && base !== undefined ? bases.get(base) : undefined;
        if (script) count.set(script, (count.get(script) ?? 0) + 1);
      },
    );
    expect(count.get('pressureplate')).toBe(419);
    expect(count.get('dunkarthspireplatepuzzlescript')).toBe(69);
  }, 300_000);

  it('finds no trap with a keyword in the vanilla records (the rule waits for one)', async () => {
    const withKeyword: number[] = [];
    for (const formId of db.formIdsOfType('ACTI')) {
      const record = await db.get(formId);
      const vmad = record?.fields.first('VMAD');
      if (!record?.fields.has('KNAM') || !vmad) continue;
      const { scripts } = parseVmad(vmad, record.type);
      if (scripts.some((script) => census.trapHitScripts.has(script.name.toLowerCase())))
        withKeyword.push(formId);
    }
    expect(withKeyword).toEqual([]);
  });
});

const MERCER_FREY_HOUSE = 0x37cc6;
const SPEAR_TRAP = 0x50c22;

describe.skipIf(!hasGamedata())('the player stands on a spear trap (headless simulation)', () => {
  let sim: Sim;
  let since = 0;

  beforeAll(async () => {
    sim = await openSim({ interior: MERCER_FREY_HOUSE, hour: 10 });
    await sim.step(1);
    since = sim.time;
    await sim.moveTo([-2371.1, 2148.9, -814.6]);
    await sim.step(3);
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('tells the trap’s start on the player (TESTrapHitEvent)', () => {
    const hits = sim.events('trapHit').filter((event) => event.trap === SPEAR_TRAP);
    expect(hits[0]).toMatchObject({ phase: 'start', target: PLAYER_REF, initial: false });
  });

  it('sends the trap OnTrapHitStart(akTarget = the player, …)', () => {
    const sent = sim.scriptEvents({ event: 'OnTrapHitStart', target: SPEAR_TRAP, since });
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0]?.args[0]).toEqual({ form: PLAYER_REF });
  });
});

const PLATE = 0x50c2b;

describe.skipIf(!hasGamedata())('a pressure plate at the first step (headless simulation)', () => {
  let sim: Sim;
  let unhurt = 0;
  let health = 0;

  beforeAll(async () => {
    sim = await openSim({ interior: MERCER_FREY_HOUSE, hour: 10 });
    await sim.step(1);
    unhurt = (await sim.runtime.actors.value(PLAYER_REF, ActorValue.health)).current;
    const at = await sim.position(PLATE);
    expect(at).toBeDefined();
    if (at) await sim.moveTo([at[0], at[1], at[2] + 8]);
    await sim.step(1.5);
    health = (await sim.runtime.actors.value(PLAYER_REF, ActorValue.health)).current;
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('activates itself, then the spears it is the activate parent of, on the one step', () => {
    const entered = sim.events('triggerEnterLeave').filter((event) => event.trigger === PLATE);
    expect(entered).toEqual([{ trigger: PLATE, reference: PLAYER_REF, entered: true }]);
    const activated = sim.events('activate');
    expect(activated).toContainEqual({ target: PLATE, actor: PLATE });
    expect(activated).toContainEqual({ target: SPEAR_TRAP, actor: PLATE });
  });

  it('hurts the player as the trap’s script processes the hit (ProcessTrapHit)  [data]', () => {
    const hits = sim.events('trapHit').filter((event) => event.target === PLAYER_REF);
    expect(hits.some((event) => event.phase === 'start')).toBe(true);
    // TrapSpear01's damage on a level 1 player: 20 (TrapHitBase, ResolveLeveledDamage).
    expect(unhurt - health).toBeGreaterThan(10);
  });
});

const WAREHOUSE_TRAPS = 0x243df;
const LOG_TRIPWIRE = 0x247b8;
const SWINGING_LOG = 0x2464c;
/** Under the log's swing: it passes here on its way down (the room's floor). */
const IN_THE_LOGS_WAY: readonly [number, number, number] = [2304, -1575, -128];

describe.skipIf(!hasGamedata())('a log set off by its tripwire (headless simulation)', () => {
  let sim: Sim;
  let actor = 0;
  let unhurt = 0;
  let since = 0;

  beforeAll(async () => {
    sim = await openSim({ interior: WAREHOUSE_TRAPS, hour: 10 });
    await sim.step(0.5);
    since = sim.time;
    actor = await sim.place(await sim.formId('NPC_', 'Hulda'), SWINGING_LOG);
    await sim.native(sim.runtime.referenceHandle(actor), 'ObjectReference', 'SetPosition', [
      ...IN_THE_LOGS_WAY,
    ]);
    await sim.step(0.2);
    unhurt = (await sim.runtime.actors.value(actor, ActorValue.health)).current;
    const wire = await sim.position(LOG_TRIPWIRE);
    expect(wire).toBeDefined();
    if (wire) await sim.moveTo([wire[0], wire[1], wire[2]]);
    await sim.until(() => sim.events('trapHit').some((event) => event.target === actor), 4);
    await sim.step(0.5);
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('swings a log trap set off by its tripwire into an actor in its way, which OnTrapHit tells  [data: TrapBatteringRam01, Tripwire]', async () => {
    expect(sim.events('activate')).toContainEqual({ target: SWINGING_LOG, actor: LOG_TRIPWIRE });
    const sent = sim.scriptEvents({ event: 'OnTrapHitStart', target: SWINGING_LOG, since });
    expect(sent[0]?.args[0]).toEqual({ form: actor });
    const health = await sim.runtime.actors.value(actor, ActorValue.health);
    expect(unhurt - health.current).toBeGreaterThan(10);
  });

  it('tells an NPC’s contact with a trap as the player’s (the movers check their controllers)  [original]', () => {
    const hits = sim.events('trapHit').filter((event) => event.target === actor);
    expect(hits[0]).toMatchObject({ trap: SWINGING_LOG, phase: 'start', initial: false });
  });
});

// TrapMace01: the mace hangs by a chain of eleven links from its base and is held up beside it
// by a pin (bhkBreakableConstraint, a ball and socket of threshold 30). MaceTrap.fireTrap makes
// its bodies simulated (SetMotionType 1), waits initialDelay (0.2 s) and pushes them down
// (ApplyHavokImpulse 0, 0, −1 by 15, then by 50): the pin breaks and the mace swings down past its
// base.
const MACE_MODEL = 'meshes\\traps\\macetrap\\trapmace01.nif';

describe.skipIf(!hasGamedata())('a hanging mace’s pin (data: TrapMace01)', () => {
  let collision: CollisionData;
  beforeAll(async () => {
    await initPhysics();
    const vfs = await Vfs.mount(openGameFolder());
    try {
      collision = buildCollision(parseNif(await vfs.read(MACE_MODEL)));
    } finally {
      await vfs.close();
    }
  });

  const hang = (): {
    physics: PhysicsWorld;
    placed: PlacedCollision;
    mace: () => [number, number, number];
    pinned: () => boolean;
  } => {
    const physics = new PhysicsWorld(new Matrix([]), GRAVITY);
    const placed = physics.addObject(
      collision,
      new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1000, 1]),
      { reference: 1, kind: 'object' },
      false,
    );
    const body = placed.bodies.find(({ data }) => data.node === 'Mace01')?.body;
    if (!body) throw new Error('no mace');
    const pin = placed.joints.find((joint) => joint.constraint.breakable);
    if (!pin) throw new Error('no pin');
    // OnCellAttach: keyframed; fireTrap: simulated.
    physics.setMotion(placed, true);
    physics.step(1 / 60);
    physics.setMotion(placed, false);
    return {
      physics,
      placed,
      mace: () => {
        const t = body.translation();
        return [t.x * HAVOK_SCALE, t.y * HAVOK_SCALE, t.z * HAVOK_SCALE - 1000];
      },
      pinned: () => pin.joint !== undefined,
    };
  };
  const push = (physics: PhysicsWorld, placed: PlacedCollision, magnitude: number): void => {
    physics.impulse(placed, [0, 0, -1], magnitude, (layer) => gameplayImpulse(1, layer, undefined));
  };

  it('holds the mace up beside its base under its weight and its chain’s', () => {
    const { physics, mace, pinned } = hang();
    const held = mace();
    // Held 126 units out from the base, a little above it.
    expect(held[0]).toBeLessThan(-120);
    expect(held[2]).toBeGreaterThan(15);
    for (let i = 0; i < 180; i++) physics.step(1 / 60);
    expect(pinned()).toBe(true);
    expect(Math.hypot(mace()[0] - held[0], mace()[2] - held[2])).toBeLessThan(5);
    physics.free();
  });

  it('lets the mace go as fireTrap pushes it, and it swings down past its base and up the other side', () => {
    const { physics, placed, mace, pinned } = hang();
    for (let i = 0; i < 12; i++) physics.step(1 / 60);
    push(physics, placed, 15);
    physics.step(1 / 60);
    push(physics, placed, 50);
    physics.step(1 / 60);
    expect(pinned()).toBe(false);
    let lowest = Infinity;
    let farthest = -Infinity;
    for (let i = 0; i < 90; i++) {
      physics.step(1 / 60);
      lowest = Math.min(lowest, mace()[2]);
      farthest = Math.max(farthest, mace()[0]);
    }
    // Down to the chain's length (132 units) under the base, and past it on the other side.
    expect(lowest).toBeLessThan(-110);
    expect(farthest).toBeGreaterThan(30);
    physics.free();
  });
});

const MACE_TRIPWIRE = 0x247a9;
const HANGING_MACE = 0x2464d;
/** Under the mace's base: its swing passes here (the room's floor). */
const IN_THE_MACES_WAY: readonly [number, number, number] = [1539, -1585, -128];

describe.skipIf(!hasGamedata())('a mace set off by its tripwire (headless simulation)', () => {
  let sim: Sim;
  let actor = 0;
  let unhurt = 0;
  let since = 0;
  let held: readonly number[] = [];
  let swung: readonly number[] = [];
  const staggered: [number, number][] = [];

  const maceAt = (): readonly number[] => {
    for (const placed of sim.world.play?.placementsOf(HANGING_MACE) ?? []) {
      const body = placed.bodies.find(({ data }) => data.node === 'Mace01')?.body;
      if (!body) continue;
      const t = body.translation();
      return [t.x * HAVOK_SCALE, t.y * HAVOK_SCALE, t.z * HAVOK_SCALE];
    }
    return [];
  };

  beforeAll(async () => {
    sim = await openSim({ interior: WAREHOUSE_TRAPS, hour: 10 });
    await sim.step(0.5);
    since = sim.time;
    held = maceAt();
    actor = await sim.place(await sim.formId('NPC_', 'Hulda'), HANGING_MACE);
    await sim.native(sim.runtime.referenceHandle(actor), 'ObjectReference', 'SetPosition', [
      ...IN_THE_MACES_WAY,
    ]);
    await sim.step(0.2);
    unhurt = (await sim.runtime.actors.value(actor, ActorValue.health)).current;
    const world = sim.runtime.world;
    const stagger = world.stagger?.bind(world);
    vi.spyOn(world, 'stagger').mockImplementation((who, magnitude, caster, from) => {
      staggered.push([who, magnitude]);
      stagger?.(who, magnitude, caster, from);
    });
    const wire = await sim.position(MACE_TRIPWIRE);
    expect(wire).toBeDefined();
    if (wire) await sim.moveTo([wire[0], wire[1], wire[2]]);
    await sim.until(() => sim.events('trapHit').some((event) => event.target === actor), 4);
    swung = maceAt();
    await sim.step(0.5);
  }, 600_000);
  afterAll(async () => {
    vi.restoreAllMocks();
    await sim.close();
  });

  it('swings the mace its tripwire sets off down from its pin  [data: TrapMace01, MaceTrap]', () => {
    expect(sim.events('activate')).toContainEqual({ target: HANGING_MACE, actor: MACE_TRIPWIRE });
    expect(held).toHaveLength(3);
    expect(swung).toHaveLength(3);
    // Held up beside its base; when it meets the actor it has swung down toward the floor.
    expect((held[2] ?? 0) - (swung[2] ?? 0)).toBeGreaterThan(100);
  });

  it('hurts and staggers the actor in its way, which OnTrapHitStart tells  [data: PhysicsTrapHit]', async () => {
    const sent = sim.scriptEvents({ event: 'OnTrapHitStart', target: HANGING_MACE, since });
    expect(sent[0]?.args[0]).toEqual({ form: actor });
    const health = await sim.runtime.actors.value(actor, ActorValue.health);
    // MaceTrap's LvlDamage1 is 40.
    expect(unhurt - health.current).toBeGreaterThan(10);
    // PhysicsTrapHit's staggerAmount on TrapMace01.
    expect(staggered).toContainEqual([actor, expect.closeTo(0.2, 5)]);
  });
});

describe('what traps do', () => {
  it('takes a body on L_CLOUDTRAP as a trap, its material told  [original]', async () => {
    await initPhysics();
    const physics = new PhysicsWorld(new Matrix([]), 0);
    const cloud = physics.world.createCollider(
      RAPIER.ColliderDesc.ball(1),
      physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed()),
    );
    physics.register(cloud, Layer.cloudTrap, { reference: 0x55, kind: 'object' });
    const actor = physics.world.createCollider(
      RAPIER.ColliderDesc.capsule(1, 0.5),
      physics.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased()),
    );
    physics.step(1 / 60);
    expect([...physics.trapsTouching(actor, 2).keys()]).toEqual([0x55]);
    physics.free();
  });
  it('carries the material of the trap’s shape touched (aeMaterial), the initial flag clear  [original]', () => {
    const hub = new EventHub();
    const told: GameEvents['trapHit'][] = [];
    hub.on('trapHit', (event) => {
      told.push(event);
    });
    const hits = new TrapHits(hub, () => 0);
    hits.touching(PLAYER_REF, new Map([[0x123, { ...TOUCH, material: 0x1234 }]]));
    expect(told[0]?.material).toBe(0x1234);
    expect(told[0]?.initial).toBe(false);
  });
  it('lets a trap whose activator has a keyword (ACTI KNAM) hit only actors that have it  [original]', async () => {
    const hub = new EventHub();
    const told: GameEvents['trapHit'][] = [];
    hub.on('trapHit', (event) => {
      told.push(event);
    });
    const KEYWORD = 0x99;
    const keywords = new ActivatorKeywords(
      (reference) => Promise.resolve(reference === 7 ? KEYWORD : undefined),
      (who, keyword) => Promise.resolve(who === 20 && keyword === KEYWORD),
    );
    const hits = new TrapHits(
      hub,
      () => 0,
      (trap, target) => keywords.admitsNow(trap, target),
    );
    // Asking takes a moment (yes meanwhile); the answer holds from then on.
    await keywords.admits(7, 20);
    keywords.admitsNow(7, 21);
    await new Promise((resolve) => setTimeout(resolve, 0));
    told.length = 0;
    hits.forget(21);
    hits.forget(20);
    hits.touching(21, new Map([[7, TOUCH]]));
    expect(told).toEqual([]);
    hits.touching(20, new Map([[7, TOUCH]]));
    expect(told.map((event) => event.target)).toEqual([20]);
    // A trap asking for nothing hits anyone.
    await keywords.admits(8, 21);
    hits.touching(21, new Map([[8, TOUCH]]));
    expect(told.map((event) => event.trap)).toEqual([7, 8]);
  });
  // The two "Trap" multipliers are the pushed body's: a blow on a body on L_TRAP takes less.
  it('pushes a body on L_TRAP by fProjectileKnockMultTrap (0.05) and fGameplayImpulseMultTrap (0.15)  [original, settings]', () => {
    const clutter = gameplayImpulse(10, Layer.clutter, undefined);
    expect(EXPLOSION_DEFAULTS.impulseMultClutter).toBe(1);
    expect(gameplayImpulse(10, Layer.trap, undefined) / clutter).toBeCloseTo(0.15);
    // fProjectileKnockMultClutter: 0.15.
    expect(arrowKnock(1000, Layer.trap, 100) / arrowKnock(1000, Layer.clutter, 100)).toBeCloseTo(
      0.05 / 0.15,
    );
  });
  // fLockTrapGoOffBase and fLockTrapGoOffMult: observed in the original, no code reads the two
  // settings; a failed pick sets no trap off, and there is no rule to build.
});

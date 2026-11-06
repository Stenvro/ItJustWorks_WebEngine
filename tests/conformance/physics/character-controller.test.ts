// Conformance: the character controller (engine map: Physics > Character controller). The
// engine's character proxy: its shape, what it pushes, how it falls and slides, and what carries
// or pushes it.
//
// Sources:
// - The engine's rule, observed in the original (src/physics/character.ts; docs/physics.md, "The character
//   controller"): the shape is hkCharControllerShape's two rings of eight points with an end
//   point below and above, in Havok's 0.05 convex shell; a body it walks into takes the push by
//   its layer and mass (nothing from fMoveLimitMass on, nor a projectile; a prop three times up to
//   half of it, else a tenth; a trap a tenth; anything else twice), its speed change held to 1000
//   Havok units a second; the graph's JumpBegin jumps the controller fJumpHeightMin high, times
//   the actor's scale.
// - CommonLibSSE (bhkCharacterController): SetPositionImpl's "force warp", TryMoveTo (a linear
//   cast validated by fGoodPosCheckDepth and fGoodPosCastCheckDepth), the proxy's character
//   interaction callback, the controller's push delta and count, kNotPushable.
// - The settings' built-in values (the engine's defaults): [HAVOK] fMoveLimitMass 95,
//   fInAirFallingCharGravityMult 1.35, fUnsupportedGravMult 4, bUseUnsupportedCast 1,
//   fUnsupportCastLength 1, fCharControllerWarpDistSqr 6,000,000, bUseCharacterRB 1,
//   bAllowCharacterBumper 1, fGoodPosCheckDepth 0.1; fJumpHeightMin 64 (Skyrim.esm 76),
//   fJumpFallVelocityMin 600 (Skyrim.esm 700).
// - Inferred (TODO(M13) in src/physics/character.ts): the warp's two places, the bump's share by
//   the masses, the Jumping Bonus as a percent, a dismount giving way to the horse's other side.
//   These cases keep those readings from changing unnoticed; they do not say the original's
//   numbers are these.

import RAPIER from '@dimforge/rapier3d-compat';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dismountPlace } from '../../../src/ai/mounts.ts';
import {
  beyondWarp,
  bumpSpeed,
  CharacterBody,
  CONTROLLER_SHELL,
  controllerPoints,
  GOOD_POSITION_DEPTH,
  jumpHeight,
  jumpSpeed,
  MOVE_LIMIT_MASS,
  pushFactor,
  pushImpulse,
  WARP_DISTANCE_SQUARED,
  type CharacterSettings,
} from '../../../src/physics/character.ts';
import { HAVOK_SCALE } from '../../../src/physics/collision-data.ts';
import { CollisionMatrix, Layer } from '../../../src/physics/collision-layers.ts';
import { GRAVITY, initPhysics, PhysicsWorld } from '../../../src/physics/physics-world.ts';
import { controllerSettings } from '../../../src/shell/player.ts';
import { IniSettings } from '../../../src/world/ini-settings.ts';
import { hasGamedata, openSim, type Sim } from '../../helpers/sim.ts';

describe('the controller’s shape (the engine’s rule)', () => {
  it('is two rings of eight points with one below and one above, in a 0.05 Havok shell', () => {
    expect(controllerPoints({ radius: 14.42, height: 131.84 })).toHaveLength(18 * 3);
    expect(CONTROLLER_SHELL).toBeCloseTo(0.05 * HAVOK_SCALE, 9);
  });
});

describe('what a character pushes (the engine’s rule)', () => {
  it('pushes nothing weighing fMoveLimitMass (95) or more, nor projectiles', () => {
    expect(MOVE_LIMIT_MASS).toBe(95);
    expect(pushFactor(Layer.clutter, 95, MOVE_LIMIT_MASS)).toBe(0);
    expect(pushFactor(Layer.projectile, 1, MOVE_LIMIT_MASS)).toBe(0);
    expect(pushFactor(Layer.clutter, 0, MOVE_LIMIT_MASS)).toBe(0);
  });

  it('pushes props three times up to half of it and a tenth above, traps a tenth, else twice', () => {
    expect(pushFactor(Layer.props, 47.5, MOVE_LIMIT_MASS)).toBe(3);
    expect(pushFactor(Layer.props, 48, MOVE_LIMIT_MASS)).toBe(0.1);
    expect(pushFactor(Layer.trap, 10, MOVE_LIMIT_MASS)).toBe(0.1);
    expect(pushFactor(Layer.clutter, 5, MOVE_LIMIT_MASS)).toBe(2);
  });

  it('holds a push’s speed change to 1000 Havok units a second', () => {
    expect(pushImpulse([5000, 0, 0], [0, 0, 0], [1, 0, 0], 1, 1)).toBeCloseTo(1000, 9);
    expect(pushImpulse([3, 0, 0], [3, 0, 0], [1, 0, 0], 5, 2)).toBe(0);
  });
});

/** Static and the character controller collide, controllers with each other too. */
const matrix = new CollisionMatrix([
  {
    formId: 1,
    editorId: 'L_STATIC',
    index: Layer.static,
    name: '',
    flags: 0,
    collidesWith: [2, 3],
  },
  {
    formId: 2,
    editorId: 'L_CHARCONTROLLER',
    index: Layer.charController,
    name: '',
    flags: 0,
    collidesWith: [1, 2, 3],
  },
  { formId: 3, editorId: 'L_PROPS', index: Layer.props, name: '', flags: 0, collidesWith: [1, 2] },
]);

const STEP = 1 / 60;
const SHAPE = { radius: 14.42, height: 131.84 };
const h = (v: number): number => v / HAVOK_SCALE;
const gravity = GRAVITY * HAVOK_SCALE;

const settings = (over: Partial<CharacterSettings> = {}): CharacterSettings => ({
  maxSlope: 60,
  fallingGravity: 1.35,
  unsupportedGravity: 4,
  stairMaterials: new Set<number>(),
  stairHeight: 32,
  ...over,
});

/** A fixed or keyframed box (game units: half extents, its middle at `at`). */
function box(
  physics: PhysicsWorld,
  half: readonly [number, number, number],
  at: readonly [number, number, number],
  kind: 'fixed' | 'kinematic' = 'fixed',
  turn: RAPIER.Rotation = { x: 0, y: 0, z: 0, w: 1 },
): RAPIER.RigidBody {
  const made = physics.world.createRigidBody(
    (kind === 'fixed'
      ? RAPIER.RigidBodyDesc.fixed()
      : RAPIER.RigidBodyDesc.kinematicPositionBased()
    )
      .setTranslation(h(at[0]), h(at[1]), h(at[2]))
      .setRotation(turn),
  );
  const collider = physics.world.createCollider(
    RAPIER.ColliderDesc.cuboid(h(half[0]), h(half[1]), h(half[2])),
    made,
  );
  physics.register(collider, Layer.static, { reference: 1, kind: 'object' });
  return made;
}

/** A character in `physics`, as an actor's. */
function character(
  physics: PhysicsWorld,
  feet: [number, number, number],
  reference = 0x100,
  over: Partial<CharacterSettings> = {},
): CharacterBody {
  return new CharacterBody(physics, SHAPE, settings(over), feet, { reference, kind: 'actor' });
}

function steps(physics: PhysicsWorld, count: number, ...bodies: CharacterBody[]): void {
  for (let i = 0; i < count; i++) {
    for (const body of bodies) body.step(STEP);
    physics.step(STEP);
  }
}

describe('falling and sliding', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  it('reads fInAirFallingCharGravityMult (1.35) and fUnsupportedGravMult (4)', () => {
    const read = controllerSettings({ ini: new IniSettings(undefined), stairMaterials: new Set() });
    expect(read.fallingGravity).toBe(1.35);
    expect(read.unsupportedGravity).toBe(4);
  });

  it('falls at gravity × 1.35 in the air, and rises at gravity alone', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    const actor = character(physics, [0, 0, 5000]);
    physics.step(STEP);
    actor.verticalSpeed = -10;
    steps(physics, 30, actor);
    expect(actor.verticalSpeed).toBeCloseTo(-10 - gravity * 1.35 * 30 * STEP, 3);
    actor.verticalSpeed = 400;
    steps(physics, 1, actor);
    expect(actor.verticalSpeed).toBeCloseTo(400 - gravity * STEP, 3);
    actor.free();
    physics.free();
  });

  /** A plane of `degrees` facing up and towards +x, through the origin, and a character on it. */
  function onSlope(
    degrees: number,
    over: Partial<CharacterSettings> = {},
  ): { physics: PhysicsWorld; actor: CharacterBody } {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    const angle = (degrees * Math.PI) / 180;
    // Its top face through the origin: its middle is half its thickness behind it.
    box(physics, [6000, 2000, 50], [-50 * Math.sin(angle), 0, -50 * Math.cos(angle)], 'fixed', {
      x: 0,
      y: Math.sin(angle / 2),
      z: 0,
      w: Math.cos(angle / 2),
    });
    physics.step(STEP);
    // Falls onto its face from just beside it.
    const feetZ = 20 - 200 * Math.tan(angle) * 0;
    const actor = character(physics, [100, 0, -100 * Math.tan(angle) + feetZ], 0x100, over);
    return { physics, actor };
  }

  it('slides off what is too steep to stand on (over the walkable 60°), × fUnsupportedGravMult', () => {
    const slide = (multiplier: number): { speed: number; grounded: boolean; x: number } => {
      const { physics, actor } = onSlope(75, { unsupportedGravity: multiplier });
      steps(physics, 360, actor);
      const at = {
        speed: -actor.verticalSpeed,
        grounded: actor.grounded,
        x: actor.feet[0],
      };
      actor.free();
      physics.free();
      return at;
    };
    const fast = slide(4);
    const slow = slide(1);
    expect(fast.grounded).toBe(false);
    expect(slow.grounded).toBe(false);
    // Down the slope; a slope's slide settles where the multiplier's gravity meets what the face
    // takes away of it each step, so the settled speeds go by the multiplier.
    expect(fast.x).toBeGreaterThan(300);
    expect(fast.speed / slow.speed).toBeGreaterThan(3.5);
    expect(fast.speed / slow.speed).toBeLessThan(4.5);
  });

  it('stands still on a slope it can walk', () => {
    const { physics, actor } = onSlope(50);
    steps(physics, 30, actor);
    expect(actor.grounded).toBe(true);
    const at = actor.feet;
    steps(physics, 120, actor);
    expect(actor.grounded).toBe(true);
    expect(Math.hypot(actor.feet[0] - at[0], actor.feet[2] - at[2])).toBeLessThan(1);
    actor.free();
    physics.free();
  });

  it('stands on a ledge’s edge, its middle out over the drop (the cone is met at its own slope)', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    // A floor at z 0 up to x 0, nothing beyond.
    box(physics, [500, 500, 10], [-500, 0, -10]);
    physics.step(STEP);
    const actor = character(physics, [6, 0, 1]);
    steps(physics, 30, actor);
    expect(actor.grounded).toBe(true);
    const at = actor.feet;
    steps(physics, 60, actor);
    expect(actor.grounded).toBe(true);
    expect(Math.abs(actor.feet[0] - at[0])).toBeLessThan(1);
    expect(Math.abs(actor.feet[2] - at[2])).toBeLessThan(1);
    actor.free();
    physics.free();
  });

  it('takes a controller further than √fCharControllerWarpDistSqr off to be warped', () => {
    expect(WARP_DISTANCE_SQUARED).toBe(6_000_000);
    const near = Math.sqrt(WARP_DISTANCE_SQUARED) - 1;
    const far = Math.sqrt(WARP_DISTANCE_SQUARED) + 1;
    expect(beyondWarp([0, 0, 0], [near, 0, 0])).toBe(false);
    expect(beyondWarp([0, 0, 0], [far, 0, 0])).toBe(true);
    expect(beyondWarp([0, 0, 100], [0, 0, 100 + far])).toBe(true);
    expect(beyondWarp([0, 0, 0], [101, 0, 0], 100 * 100)).toBe(true);
  });

  it('calls a place good only with the shape less than fGoodPosCheckDepth (0.1) deep in things', () => {
    expect(GOOD_POSITION_DEPTH).toBe(0.1);
    const physics = new PhysicsWorld(matrix, GRAVITY);
    // A wall from x 0 on.
    box(physics, [100, 500, 500], [100, 0, 0]);
    physics.step(STEP);
    const actor = character(physics, [-500, 0, -50]);
    physics.step(STEP);
    const across = SHAPE.radius + CONTROLLER_SHELL;
    const depth = GOOD_POSITION_DEPTH * HAVOK_SCALE;
    expect(actor.goodPosition([-100, 0, -50])).toBe(true);
    expect(actor.goodPosition([-across + depth / 2, 0, -50])).toBe(true);
    expect(actor.goodPosition([-across + depth * 2, 0, -50])).toBe(false);
    expect(actor.goodPosition([50, 0, -50])).toBe(false);
    actor.free();
    physics.free();
  });

  it('moves to a place only where its sweep there meets nothing and the place is good', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    box(physics, [50, 500, 500], [0, 0, 0]);
    physics.step(STEP);
    const actor = character(physics, [-300, 0, -50]);
    physics.step(STEP);
    // Behind the wall: a good place, but its way there goes through the wall.
    expect(actor.goodPosition([300, 0, -50])).toBe(true);
    expect(actor.tryMoveTo([300, 0, -50])).toBe(false);
    expect(actor.feet[0]).toBe(-300);
    // Into the wall, past the depth.
    expect(actor.tryMoveTo([0, 0, -50])).toBe(false);
    expect(actor.tryMoveTo([-150, 0, -50])).toBe(true);
    expect(actor.feet[0]).toBe(-150);
    actor.free();
    physics.free();
  });

  it('sets a rider down on the horse’s other side where a wall leaves no room', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    const horse = { position: [0, 0, 0] as const, heading: 0 };
    // Against the wall on the horse's left, where the dismount ends (x −111.6).
    box(physics, [50, 500, 500], [-130, 0, 200]);
    physics.step(STEP);
    const rider = character(physics, [0, 0, 500]);
    physics.step(STEP);
    const off = dismountPlace(horse, (place) => rider.goodPosition([place[0], place[1], place[2]]));
    expect(off.position[0]).toBeCloseTo(111.6, 3);
    // Room there: the dismount's end, as without a check.
    expect(dismountPlace(horse, () => true).position[0]).toBeCloseTo(-111.6, 3);
    expect(dismountPlace(horse).position[0]).toBeCloseTo(-111.6, 3);
    // No room anywhere: the dismount's end all the same.
    expect(dismountPlace(horse, () => false).position[0]).toBeCloseTo(-111.6, 3);
    rider.free();
    physics.free();
  });
});

describe('jumping', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  it('jumps fJumpHeightMin × its scale × its Jumping Bonus’s share, × fJumpSwimmingMult in water', () => {
    const rule = { min: 76, swimmingMult: 2 };
    const human = { scale: 1, jumpingBonus: 0, swimming: false };
    expect(jumpHeight(rule, human)).toBe(76);
    expect(jumpHeight(rule, { ...human, swimming: true })).toBe(152);
    expect(jumpHeight(rule, { ...human, scale: 1.25 })).toBe(95);
    expect(jumpHeight(rule, { ...human, jumpingBonus: 100 })).toBe(152);
    expect(jumpHeight(rule, { ...human, jumpingBonus: -200 })).toBe(0);
  });

  it('takes off at the speed that reaches that height under gravity alone', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    box(physics, [500, 500, 10], [0, 0, -10]);
    physics.step(STEP);
    const actor = character(physics, [0, 0, 1]);
    steps(physics, 10, actor);
    const start = actor.feet[2];
    actor.jump(jumpSpeed(76, gravity));
    let top = start;
    for (let i = 0; i < 60; i++) {
      actor.step(STEP);
      physics.step(STEP);
      top = Math.max(top, actor.feet[2]);
    }
    // The first step goes at the whole speed: half a step's way over the height.
    expect(top - start).toBeGreaterThan(76);
    expect(top - start).toBeLessThan(79.5);
    actor.free();
    physics.free();
  });
});

describe('what carries and pushes characters', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  it('carries an actor standing on a moving platform (a keyframed body) with it', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    const lift = box(physics, [300, 300, 10], [0, 0, -10], 'kinematic');
    physics.step(STEP);
    const actor = character(physics, [0, 0, 1]);
    steps(physics, 10, actor);
    const start = actor.feet;
    for (let i = 1; i <= 60; i++) {
      lift.setNextKinematicTranslation({ x: h(i * 2), y: 0, z: h(-10 + i) });
      actor.step(STEP);
      physics.step(STEP);
    }
    expect(Math.abs(actor.feet[0] - start[0] - 120)).toBeLessThan(3);
    expect(Math.abs(actor.feet[2] - start[2] - 60)).toBeLessThan(3);
    expect(actor.grounded).toBe(true);
    actor.free();
    physics.free();
  });

  it('is pushed by a simulated body that runs into it (a rolling log)', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    box(physics, [2000, 500, 10], [0, 0, -10]);
    const log = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(h(-150), 0, h(40))
        .setLinvel(h(300), 0, 0)
        .setGravityScale(0),
    );
    const shape = physics.world.createCollider(RAPIER.ColliderDesc.ball(h(40)).setMass(400), log);
    physics.register(shape, Layer.props, { reference: 2, kind: 'object' });
    physics.step(STEP);
    const actor = character(physics, [0, 0, 1]);
    steps(physics, 60, actor);
    expect(actor.feet[0]).toBeGreaterThan(30);
    actor.free();
    physics.free();
  });

  it('is put out of the way of a keyframed body that swings into it (a swinging trap)', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    box(physics, [2000, 500, 10], [0, 0, -10]);
    const ram = box(physics, [20, 100, 100], [-100, 0, 100], 'kinematic');
    physics.step(STEP);
    const actor = character(physics, [0, 0, 1]);
    steps(physics, 10, actor);
    for (let i = 1; i <= 60; i++) {
      ram.setNextKinematicTranslation({ x: h(-100 + i * 5), y: 0, z: h(100) });
      actor.step(STEP);
      physics.step(STEP);
    }
    // The ram's front at x 220; the shape's back stays at it or past it.
    expect(actor.feet[0] - SHAPE.radius).toBeGreaterThan(200);
    actor.free();
    physics.free();
  });

  it('gives another a share of its closing speed by their masses, none closing or massless', () => {
    expect(bumpSpeed(200, 100, 100)).toBe(100);
    expect(bumpSpeed(200, 300, 100)).toBe(150);
    expect(bumpSpeed(200, 100, 300)).toBe(50);
    expect(bumpSpeed(-10, 100, 100)).toBe(0);
    expect(bumpSpeed(200, 0, 100)).toBe(0);
    expect(bumpSpeed(1e5, 100, 1)).toBeLessThanOrEqual(400);
  });

  /** A walks at 200 units a second into B, standing 60 units ahead, for two seconds. */
  function walkInto(
    set: (a: CharacterBody, b: CharacterBody) => void,
    over: Partial<CharacterSettings> = {},
  ): { a: number; b: number } {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    box(physics, [3000, 500, 10], [0, 0, -10]);
    physics.step(STEP);
    const a = character(physics, [0, 0, 1], 0x100, over);
    const b = character(physics, [60, 0, 1], 0x101, over);
    steps(physics, 10, a, b);
    set(a, b);
    a.velocity = [200, 0];
    steps(physics, 120, a, b);
    const at = { a: a.feet[0], b: b.feet[0] };
    a.free();
    b.free();
    physics.free();
    return at;
  }

  it('lets two characters push one another (bAllowCharacterBumper)', () => {
    const { a, b } = walkInto(() => undefined);
    // Without it B stays at 60 and A stops some 30 units short of it.
    expect(b).toBeGreaterThan(160);
    expect(a).toBeGreaterThan(120);
    expect(b - a).toBeGreaterThan(25);
  });

  it('pushes a light one further than a heavy one', () => {
    const light = walkInto((_, b) => {
      b.mass = 20;
    });
    const heavy = walkInto((_, b) => {
      b.mass = 2000;
    });
    expect(light.b).toBeGreaterThan(heavy.b + 40);
    expect(heavy.b).toBeLessThan(120);
  });

  it('pushes nobody with the setting off, or either’s bumper off (DisableBumper)', () => {
    const still = (at: { a: number; b: number }): void => {
      expect(Math.abs(at.b - 60)).toBeLessThan(1);
      expect(at.a).toBeLessThan(30);
    };
    still(walkInto(() => undefined, { bumper: false }));
    still(
      walkInto((a) => {
        a.bumper = false;
      }),
    );
    still(
      walkInto((_, b) => {
        b.bumper = false;
      }),
    );
  });

  it('reads bAllowCharacterBumper (on) and fGoodPosCheckDepth (0.1) from the settings', () => {
    const read = controllerSettings({ ini: new IniSettings(undefined), stairMaterials: new Set() });
    expect(read.bumper).toBe(true);
    expect(read.goodPositionDepth).toBe(0.1);
  });
});

/** WhiterunWorld [0001A26F]: its busiest cell, outdoors (nothing over the actors' heads). */
const WHITERUN_WORLD = 0x1a26f;

describe.skipIf(!hasGamedata())('an NPC’s controller (headless simulation)', () => {
  let sim: Sim;
  const actor = 0x1a6a4;

  beforeAll(async () => {
    sim = await openSim({ hour: 12, gridRadius: 1 });
    const cell = (await sim.world.session.worldspace(WHITERUN_WORLD)).busiestCell() ?? [0, 0];
    await sim.openExterior(WHITERUN_WORLD, cell);
    await sim.step(3);
    // Nazeem [0001A6A4] as he stands in the market at noon: the one whose graph is updated here,
    // not the guards further off.
    const nazeem = await sim.position(actor);
    if (nazeem) await sim.moveTo([nazeem[0] + 200, nazeem[1], nazeem[2]]);
    await sim.step(1);
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  const staged = (): NonNullable<ReturnType<Sim['actor']>> => {
    const found = sim.actor(actor);
    if (!found) throw new Error('no actor');
    return found;
  };

  it('answers its graph’s jump: its JumpBegin jumps its controller fJumpHeightMin (76) high', async () => {
    const start = staged().position[2];
    const stage = sim.world.stage;
    expect(await stage.furniture.playAction(stage.userOf(staged()), 'ActionJump')).toBe(true);
    let top = start;
    for (let i = 0; i < 120; i++) {
      await sim.step(1 / 60);
      top = Math.max(top, staged().position[2]);
    }
    const scale = staged().placed.actor.scale * staged().placed.look.scale;
    expect(top - start).toBeGreaterThan(60 * scale);
    expect(top - start).toBeLessThan(80 * scale);
  }, 120_000);

  it('warps its controller to where it should be only further than √fCharControllerWarpDistSqr', async () => {
    await sim.step(1);
    const was = [...staged().position] as [number, number, number];
    // Set there behind the controller's back: near, the controller goes on from where it is.
    staged().position = [was[0] + 1000, was[1], was[2]];
    await sim.step(0.1);
    expect(Math.hypot(staged().position[0] - was[0], staged().position[1] - was[1])).toBeLessThan(
      200,
    );
    // Far, it is set there.
    const back = [...staged().position] as [number, number, number];
    staged().position = [back[0] + 3000, back[1], back[2] + 200];
    await sim.step(0.1);
    expect(staged().position[0] - back[0]).toBeGreaterThan(2800);
  }, 120_000);
});

import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { FrameTimer } from '../world/frame-timer.ts';
import { CharacterBody } from './character.ts';
import { HAVOK_SCALE } from './collision-data.ts';
import { CollisionMatrix, Layer } from './collision-layers.ts';
import { GRAVITY, initPhysics, PhysicsWorld } from './physics-world.ts';

// A character goes the frame's whole way in the physics steps the frame is handed
// (PhysicsWorld.movePace; observed in the original: its controller goes the way it wants in the
// frame over the time physics was handed). Below 20 frames a second a frame is handed three
// steps, less than its time: moved by the steps alone, a character walked at 72% of its speed at
// 15 frames a second and at 32% at 7, while its animation ran the frame's whole step.

const matrix = new CollisionMatrix([
  { formId: 1, editorId: 'L_STATIC', index: Layer.static, name: '', flags: 0, collidesWith: [2] },
  {
    formId: 2,
    editorId: 'L_CHARCONTROLLER',
    index: Layer.charController,
    name: '',
    flags: 0,
    collidesWith: [1, 2],
  },
]);
const SETTINGS = {
  maxSlope: 60,
  fallingGravity: 1,
  unsupportedGravity: 1,
  stairMaterials: new Set<number>(),
  stairHeight: 32,
};
const STEP = 1 / 60;
const SPEED = 370;
const h = (v: number): number => v / HAVOK_SCALE;

beforeAll(async () => {
  await initPhysics();
});

/** A character standing on flat ground (and `others` at their feet beside it). */
function standing(...others: [number, number, number][]): {
  physics: PhysicsWorld;
  character: CharacterBody;
  others: CharacterBody[];
} {
  const physics = new PhysicsWorld(matrix, GRAVITY);
  const body = physics.world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, h(-10)),
  );
  const collider = physics.world.createCollider(
    RAPIER.ColliderDesc.cuboid(h(100000), h(1000), h(10)),
    body,
  );
  physics.register(collider, Layer.static, { reference: 1, kind: 'object' });
  physics.step(STEP);
  const character = new CharacterBody(physics, { radius: 14, height: 130 }, SETTINGS, [0, 0, 1], {
    reference: 2,
    kind: 'actor',
  });
  const placed = others.map(
    (feet, i) =>
      new CharacterBody(physics, { radius: 14, height: 130 }, SETTINGS, feet, {
        reference: 3 + i,
        kind: 'actor',
      }),
  );
  for (let i = 0; i < 10; i++) {
    character.step(STEP);
    for (const other of placed) other.step(STEP);
    physics.step(STEP);
  }
  return { physics, character, others: placed };
}

/**
 * Frames at `rate` a second for about `seconds`, the character walking along x as the player and
 * the movers move theirs: how far it went, the clock's time, the steps taken and the time its
 * movement covered.
 */
function walk(
  physics: PhysicsWorld,
  character: CharacterBody,
  timer: FrameTimer,
  rate: number,
  seconds: number,
): { went: number; clock: number; steps: number; covered: number } {
  const from = character.feet[0];
  let clock = 0;
  let steps = 0;
  let covered = 0;
  character.velocity = [SPEED, 0];
  for (let frame = 0; frame < Math.round(seconds * rate); frame++) {
    const step = timer.step(1 / rate);
    clock += step;
    steps += physics.step(step, (size) => {
      covered += size * physics.movePace;
      character.step(size, size * physics.movePace);
    });
  }
  return { went: character.feet[0] - from, clock, steps, covered };
}

describe("a character's way in the steps a frame is handed (movePace)", () => {
  it('is 1 while a frame is handed its whole time', () => {
    const { physics, character } = standing();
    const run = walk(physics, character, new FrameTimer(), 60, 2);
    expect(physics.movePace).toBe(1);
    expect(run.covered).toBeCloseTo(run.steps * STEP, 9);
    expect(run.went / (SPEED * run.clock)).toBeGreaterThan(0.97);
    expect(run.went / (SPEED * run.clock)).toBeLessThan(1.03);
    physics.free();
  });

  for (const rate of [15, 7]) {
    it(`goes the clock's whole way at ${String(rate)} frames a second, three steps a frame`, () => {
      const { physics, character } = standing();
      const timer = new FrameTimer();
      // The timer's history holds the rate alone.
      for (let i = 0; i < 10; i++) timer.step(1 / rate);
      const run = walk(physics, character, timer, rate, 4);
      // Three steps a frame, less than the frame's time: the bodies are behind the clock.
      expect(run.steps).toBe(3 * Math.round(4 * rate));
      expect(run.steps * STEP).toBeLessThan(run.clock * 0.75);
      expect(physics.movePace).toBeCloseTo(run.clock / (run.steps * STEP), 6);
      // The character's movement covered the clock's time, and it went that far.
      expect(run.covered).toBeCloseTo(run.clock, 6);
      expect(run.went / (SPEED * run.clock)).toBeGreaterThan(0.98);
      expect(run.went / (SPEED * run.clock)).toBeLessThan(1.02);
      // Its graph is told its own speed, not the faster one each step went at.
      expect(character.stepVelocity[0]).toBeCloseTo(SPEED, 0);
      physics.free();
    });
  }

  it('goes no faster while the time owed is made up at three steps a frame', () => {
    const { physics, character } = standing();
    const timer = new FrameTimer();
    for (let i = 0; i < 10; i++) timer.step(1 / 10);
    walk(physics, character, timer, 10, 3);
    // Back at 60 frames a second: the frames' steps come back to 1/60 s within the timer's
    // history, the time owed (held to one frame's, a tenth of a second) is handed out in extra
    // steps, and the character goes on at its own speed: taken whole, those steps alone would
    // make it a tenth faster.
    for (let i = 0; i < 10; i++) timer.step(1 / 60);
    const run = walk(physics, character, timer, 60, 0.5);
    expect(run.steps).toBeGreaterThan(30);
    expect(run.steps).toBeLessThanOrEqual(30 + 6);
    expect(run.went / (SPEED * run.clock)).toBeGreaterThan(0.98);
    expect(run.went / (SPEED * run.clock)).toBeLessThan(1.02);
    physics.free();
  });

  it("falls by the frames' time, as its wanted way goes", () => {
    const { physics, character } = standing();
    const timer = new FrameTimer();
    for (let i = 0; i < 10; i++) timer.step(1 / 10);
    character.teleport([0, 0, 2000]);
    character.velocity = [0, 0];
    // In the air (two steps to leave the ground it stood on: the first sweeps from there).
    for (let i = 0; i < 2; i++) {
      character.step(STEP);
      physics.step(STEP);
    }
    expect(character.grounded).toBe(false);
    const top = character.feet[2];
    const speed = -character.verticalSpeed;
    let steps = 0;
    let clock = 0;
    for (let frame = 0; frame < 5; frame++) {
      const step = timer.step(1 / 10);
      clock += step;
      steps += physics.step(step, (size) => {
        character.step(size, size * physics.movePace);
      });
    }
    // 15 steps handed, 0.25 s, but its fall covered the frames' 0.54 s: about v t + ½ g t² over
    // that (g × the fall's multiplier of 1, in game units), 4.7 times as far as the steps' own
    // time would make it.
    expect(steps).toBe(15);
    const fell = top - character.feet[2];
    const g = GRAVITY * HAVOK_SCALE;
    const free = speed * clock + 0.5 * g * clock * clock;
    expect(fell).toBeGreaterThan(free * 0.97);
    expect(fell).toBeLessThan(free * 1.05);
    expect(-character.verticalSpeed).toBeCloseTo(speed + g * clock, 0);
    physics.free();
  });
});

/** A plane tilted `degrees` about y, going down along +x, and a character standing on it. */
function onSlope(degrees: number): { physics: PhysicsWorld; character: CharacterBody } {
  const physics = new PhysicsWorld(matrix, GRAVITY);
  const angle = (degrees * Math.PI) / 180;
  const body = physics.world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed()
      .setTranslation(0, 0, 0)
      .setRotation({ x: 0, y: Math.sin(angle / 2), z: 0, w: Math.cos(angle / 2) }),
  );
  const collider = physics.world.createCollider(
    RAPIER.ColliderDesc.cuboid(h(200000), h(2000), h(10)),
    body,
  );
  physics.register(collider, Layer.static, { reference: 1, kind: 'object' });
  physics.step(STEP);
  const character = new CharacterBody(physics, { radius: 14, height: 130 }, SETTINGS, [0, 0, 40], {
    reference: 2,
    kind: 'actor',
  });
  for (let i = 0; i < 60; i++) {
    character.step(STEP);
    physics.step(STEP);
  }
  return { physics, character };
}

/** A timer whose history holds `rate` frames a second alone. */
function timerAt(rate: number): FrameTimer {
  const timer = new FrameTimer();
  for (let i = 0; i < 10; i++) timer.step(1 / rate);
  return timer;
}

/**
 * Walking down a slope of `degrees` for 8 s at `rate` frames a second: the share of the physics
 * steps it ended on the ground (where the player's controls are taken), and how far it went
 * against its speed times the clock.
 */
function downhill(rate: number, degrees: number): { grounded: number; went: number } {
  const { physics, character } = onSlope(degrees);
  const timer = timerAt(rate);
  character.velocity = [SPEED, 0];
  const from = character.feet[0];
  let clock = 0;
  let steps = 0;
  let grounded = 0;
  for (let frame = 0; frame < 8 * rate; frame++) {
    const step = timer.step(1 / rate);
    clock += step;
    physics.step(step, (size) => {
      character.step(size, size * physics.movePace);
      steps++;
      if (character.grounded) grounded++;
    });
  }
  const went = (character.feet[0] - from) / (SPEED * clock);
  physics.free();
  return { grounded: grounded / steps, went };
}

describe('a character walking down a slope at any frame rate', () => {
  for (const degrees of [5, 10, 20]) {
    it(`keeps to ${String(degrees)} degrees as at 60 frames a second`, () => {
      // At 60 frames a second it stays on the slope (Rapier's controller left it, its foot ever
      // higher above it, and it fell to it: on 20 degrees off the ground three steps of five).
      const base = downhill(60, degrees);
      expect(base.grounded).toBeGreaterThan(0.97);
      for (const rate of [30, 15, 10, 7]) {
        const run = downhill(rate, degrees);
        // In one long move a step: grounded 67% of the steps on 10 degrees at 15 frames a second.
        expect(Math.abs(run.grounded - base.grounded), `${String(rate)} a second`).toBeLessThan(
          0.03,
        );
        // The frame's whole way is still gone.
        expect(Math.abs(run.went - base.went), `${String(rate)} a second`).toBeLessThan(0.04);
      }
    });
  }
});

/**
 * A running jump on flat ground at `rate` frames a second (after `owed` frames of 0.1083 s that
 * leave physics time to make up): how far it lands from where it jumped and how high its feet
 * went. Where it lands is reckoned from its last step in the air, by its fall from there.
 */
function runningJump(rate: number, owed = 0): { reach: number; height: number } {
  const { physics, character } = standing();
  const timer = timerAt(rate);
  character.velocity = [SPEED, 0];
  for (let frame = 0; frame < owed; frame++) {
    physics.step(0.1083, (size) => {
      character.step(size, size * physics.movePace);
    });
  }
  for (let frame = 0; frame < rate / 2; frame++) {
    physics.step(timer.step(1 / rate), (size) => {
      character.step(size, size * physics.movePace);
    });
  }
  expect(character.grounded).toBe(true);
  const [x0, , z0] = character.feet;
  character.jump(300);
  const g = GRAVITY * HAVOK_SCALE;
  let height = 0;
  let air: { x: number; z: number; vz: number } | undefined;
  // Set in the steps' callback (an object: the loop's test reads it after each frame).
  const jump = { landed: false };
  for (let frame = 0; frame < 10 * rate && !jump.landed; frame++) {
    physics.step(timer.step(1 / rate), (size) => {
      if (jump.landed) return;
      character.step(size, size * physics.movePace);
      const [x, , z] = character.feet;
      height = Math.max(height, z - z0);
      if (character.grounded && air) jump.landed = true;
      else if (!character.grounded) air = { x, z: z - z0, vz: character.verticalSpeed };
    });
  }
  physics.free();
  expect(jump.landed).toBe(true);
  if (!air) throw new Error('never in the air');
  const t = (air.vz + Math.sqrt(air.vz * air.vz + 2 * g * air.z)) / g;
  return { reach: air.x + SPEED * t - x0, height };
}

describe("a character's running jump at any frame rate", () => {
  it('goes as far and as high as at 60 frames a second', () => {
    const base = runningJump(60);
    // ½ v² / g: some 65 units up; v / g × 2 × 370: some 320 units along.
    expect(base.height).toBeGreaterThan(55);
    expect(base.reach).toBeGreaterThan(280);
    for (const rate of [30, 15, 10, 7]) {
      const run = runningJump(rate);
      // With the way paced and the fall by the step: 462 units at 15 a second, 1054 at 7.
      expect(run.reach / base.reach, `${String(rate)} a second`).toBeGreaterThan(0.95);
      expect(run.reach / base.reach, `${String(rate)} a second`).toBeLessThan(1.05);
      expect(run.height / base.height, `${String(rate)} a second`).toBeGreaterThan(0.95);
      expect(run.height / base.height, `${String(rate)} a second`).toBeLessThan(1.05);
    }
    // While physics makes up time it owes (a third of a frame's time a step): no shorter (it
    // was 111 units).
    const owed = runningJump(60, 40);
    expect(owed.reach / base.reach).toBeGreaterThan(0.95);
    expect(owed.reach / base.reach).toBeLessThan(1.05);
    expect(owed.height / base.height).toBeGreaterThan(0.95);
    expect(owed.height / base.height).toBeLessThan(1.05);
  });
});

describe('two characters walking together at any frame rate', () => {
  /** B just ahead of A, both walking along x at `rate` for 3 s: how far apart they end. */
  function together(rate: number): number {
    const {
      physics,
      character: a,
      others: [b],
    } = standing([36, 0, 1]);
    if (!b) throw new Error('no second character');
    const timer = timerAt(rate);
    a.velocity = [SPEED, 0];
    b.velocity = [SPEED, 0];
    for (let frame = 0; frame < 3 * rate; frame++) {
      physics.step(timer.step(1 / rate), (size) => {
        a.step(size, size * physics.movePace);
        b.step(size, size * physics.movePace);
      });
    }
    const apart = b.feet[0] - a.feet[0];
    physics.free();
    return apart;
  }

  it('the one behind shoves the one ahead no more at a low frame rate', () => {
    // Some 43 units apart at 60 frames a second, centre to centre.
    const base = together(60);
    expect(base).toBeLessThan(50);
    for (const rate of [15, 10]) {
      // By its paced speed against the other's own the one behind shoved the one ahead on (0.2
      // of its speed at 15 frames a second, 0.6 at 10): 66 and 82 units apart.
      expect(together(rate) - base, `${String(rate)} a second`).toBeLessThan(15);
    }
  });
});

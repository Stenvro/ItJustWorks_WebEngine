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

function standing(): { physics: PhysicsWorld; character: CharacterBody } {
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
  for (let i = 0; i < 10; i++) {
    character.step(STEP);
    physics.step(STEP);
  }
  return { physics, character };
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
      physics.free();
    });
  }

  it('goes no faster while the time owed is made up at three steps a frame', () => {
    const { physics, character } = standing();
    const timer = new FrameTimer();
    for (let i = 0; i < 10; i++) timer.step(1 / 10);
    walk(physics, character, timer, 10, 3);
    // Back at 60 frames a second: the frames' steps come back to 1/60 s within the timer's
    // history, the time owed is handed out three steps a frame, and the character goes on at its
    // own speed.
    for (let i = 0; i < 10; i++) timer.step(1 / 60);
    const run = walk(physics, character, timer, 60, 0.5);
    expect(run.steps).toBe(3 * 30);
    expect(physics.movePace).toBeCloseTo(1 / 3, 6);
    expect(run.went / (SPEED * run.clock)).toBeGreaterThan(0.98);
    expect(run.went / (SPEED * run.clock)).toBeLessThan(1.02);
    physics.free();
  });

  it('falls by the step, not by the pace', () => {
    const { physics, character } = standing();
    const timer = new FrameTimer();
    for (let i = 0; i < 10; i++) timer.step(1 / 10);
    character.teleport([0, 0, 2000]);
    character.velocity = [0, 0];
    let steps = 0;
    for (let frame = 0; frame < 5; frame++) {
      steps += physics.step(timer.step(1 / 10), (size) => {
        character.step(size, size * physics.movePace);
      });
    }
    // 15 steps of free fall (g × the fall's multiplier of 1): about ½ g t² in game units, not
    // the 4.7 times as far the frames' 0.54 s would make it.
    expect(steps).toBe(15);
    const t = steps * STEP;
    const fell = 2000 - character.feet[2];
    expect(fell).toBeGreaterThan(0.5 * GRAVITY * HAVOK_SCALE * t * t * 0.75);
    expect(fell).toBeLessThan(0.5 * GRAVITY * HAVOK_SCALE * t * t * 1.25);
    physics.free();
  });
});

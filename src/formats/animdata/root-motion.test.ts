import { describe, expect, it } from 'vitest';
import type { ClipMotion, Quat } from './animation-data.ts';
import { rootMotionAt, rootMotionDelta, rootMotionTotal, rotate, slerp } from './root-motion.ts';

const yaw = (radians: number): Quat => [0, 0, Math.sin(radians / 2), Math.cos(radians / 2)];

/** Walks 100 units forward in 1 s at a steady pace. */
const WALK: ClipMotion = {
  clipId: 1,
  duration: 1,
  translations: [{ time: 1, value: [0, 100, 0] }],
  rotations: [{ time: 1, value: [0, 0, 0, 1] }],
};

/** Steps 20 forward by 0.5 s, then 80 more while turning left by 90° (2 s). */
const TURN: ClipMotion = {
  clipId: 2,
  duration: 2,
  translations: [
    { time: 0.5, value: [0, 20, 0] },
    { time: 2, value: [0, 100, 0] },
  ],
  rotations: [
    { time: 1, value: yaw(Math.PI / 4) },
    { time: 2, value: yaw(Math.PI / 2) },
  ],
};

const expectVec = (actual: readonly number[], expected: readonly number[]): void => {
  expected.forEach((value, i) => {
    expect(actual[i]).toBeCloseTo(value, 4);
  });
};

describe('rootMotionAt', () => {
  it('starts from zero and the identity before the first key', () => {
    const start = rootMotionAt(TURN, 0);
    expectVec(start.translation, [0, 0, 0]);
    expectVec(start.rotation, [0, 0, 0, 1]);
    expectVec(rootMotionAt(TURN, 0.25).translation, [0, 10, 0]);
  });

  it('interpolates translations linearly and rotations spherically', () => {
    expectVec(rootMotionAt(TURN, 1.25).translation, [0, 60, 0]);
    expectVec(rootMotionAt(TURN, 0.5).rotation, yaw(Math.PI / 8));
    expectVec(rootMotionAt(TURN, 1.5).rotation, yaw((3 * Math.PI) / 8));
  });

  it('clamps the time to the clip', () => {
    expectVec(rootMotionAt(WALK, 5).translation, [0, 100, 0]);
    expectVec(rootMotionAt(WALK, -1).translation, [0, 0, 0]);
  });
});

describe('rootMotionDelta', () => {
  it('is the motion between two times in the frame at the first', () => {
    expectVec(rootMotionDelta(WALK, 0.2, 0.7).translation, [0, 50, 0]);
    // Turned by 45° at t = 1, the 40 units ahead in the clip's frame are partly to the right.
    const delta = rootMotionDelta(TURN, 1, 1.75);
    const step = 80 * (0.75 / 1.5);
    const back = rotate(yaw(-Math.PI / 4), [0, step, 0]);
    expectVec(delta.translation, back);
    expectVec(delta.rotation, slerp(yaw(0), yaw(Math.PI / 4), 0.75));
  });

  it('wraps around the end of a looping clip', () => {
    expectVec(rootMotionDelta(WALK, 0.9, 0.1).translation, [0, 20, 0]);
    // 1.5 → 2 (yaw 67.5° → 90°, 26.67 ahead), then 0 → 0.5 from the clip's start again.
    const loop = rootMotionDelta(TURN, 1.5, 0.5);
    const rest = rotate(yaw((-3 * Math.PI) / 8), [0, 100 - (20 + 80 / 1.5), 0]);
    const again = rotate(yaw(Math.PI / 8), [0, 20, 0]);
    expectVec(loop.translation, [rest[0] + again[0], rest[1] + again[1], 0]);
    expectVec(loop.rotation, yaw(Math.PI / 4));
  });
});

describe('rootMotionTotal', () => {
  it('gives where the clip ends, its distance, speed and turn', () => {
    const walk = rootMotionTotal(WALK);
    expect(walk.distance).toBeCloseTo(100);
    expect(walk.speed).toBeCloseTo(100);
    expect(walk.yaw).toBeCloseTo(0);
    expect(rootMotionTotal(TURN).speed).toBeCloseTo(50);
    expect(rootMotionTotal(TURN).yaw).toBeCloseTo(Math.PI / 2, 5);
  });
});

describe('slerp', () => {
  it('takes the shorter arc and stays normalised', () => {
    const a = yaw(0);
    const b: Quat = [0, 0, -Math.sin(Math.PI / 4), -Math.cos(Math.PI / 4)]; // 90° (negated)
    const half = slerp(a, b, 0.5);
    expectVec(half, yaw(Math.PI / 4));
    expect(Math.hypot(...half)).toBeCloseTo(1, 10);
  });
});

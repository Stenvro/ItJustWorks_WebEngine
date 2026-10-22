import { describe, expect, it } from 'vitest';
import { TRANSFORM_FLOATS } from '../formats/hkx/animation.ts';
import { intoMatchFrame, matchPose } from './pose-matching.ts';

/** Bone positions (x, y, z per bone): root, other, another. */
const positions = (...points: [number, number, number][]): Float32Array =>
  Float32Array.from(points.flat());

/** Turns points about z by an angle (counter-clockwise) and shifts them. */
const turned = (
  points: [number, number, number][],
  angle: number,
  shift: [number, number],
): [number, number, number][] =>
  points.map(([x, y, z]) => [
    x * Math.cos(angle) - y * Math.sin(angle) + shift[0],
    x * Math.sin(angle) + y * Math.cos(angle) + shift[1],
    z,
  ]);

const bones = { root: 0, other: 1, another: 2 };
// Lying on its back: the neck ahead of the root, the left arm to its left, both low.
const onBack: [number, number, number][] = [
  [0, 0, 10],
  [0, 60, 12],
  [-20, 50, 15],
];
// On its front: the left arm on the other side.
const onFront: [number, number, number][] = [
  [0, 0, 10],
  [0, 60, 12],
  [20, 50, 15],
];

describe('pose matching', () => {
  it('picks the get-up pose lying as the ragdoll does, with the turn and shift that fit it', () => {
    const ragdoll = positions(...turned(onFront, 1, [300, -40]));
    const match = matchPose(ragdoll, [positions(...onBack), positions(...onFront)], bones);
    expect(match?.index).toBe(1);
    expect(match?.yaw).toBeCloseTo(1, 5);
    expect(match?.offset[0]).toBeCloseTo(300, 3);
    expect(match?.offset[1]).toBeCloseTo(-40, 3);
    expect(match?.error).toBeCloseTo(0, 5);
  });

  it('moves a pose into the frame of a match (its roots turned back and shifted)', () => {
    const pose = new Float32Array(2 * TRANSFORM_FLOATS);
    // Root at (310, -40) facing +x turned by 1 radian; the child is left as it is.
    pose.set([310, -40, 5, 0, 0, Math.sin(0.5), Math.cos(0.5), 1, 1, 1], 0);
    pose.set([1, 2, 3, 0, 0, 0, 1, 1, 1, 1], TRANSFORM_FLOATS);
    intoMatchFrame(pose, Int16Array.from([-1, 0]), { yaw: 1, offset: [300, -40] });
    expect(pose[0]).toBeCloseTo(10 * Math.cos(-1), 5);
    expect(pose[1]).toBeCloseTo(10 * Math.sin(-1), 5);
    expect(pose[2]).toBe(5);
    // The root's own turn of 1 radian is undone.
    expect(pose[5]).toBeCloseTo(0, 5);
    expect(Math.abs(pose[6] ?? 0)).toBeCloseTo(1, 5);
    expect(Array.from(pose.subarray(TRANSFORM_FLOATS, TRANSFORM_FLOATS + 3))).toEqual([1, 2, 3]);
  });

  it('matches nothing without candidates', () => {
    expect(matchPose(positions(...onBack), [], bones)).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { identity } from '../render/math.ts';
import { corpsePose, placeCorpsePose } from './corpse-pose.ts';
import { ActorPose, ActorSkeleton, type RigData } from './skeleton.ts';

/** A root, a pelvis 50 up and a thigh 10 below the pelvis. */
function skeleton(): ActorSkeleton {
  const local = new Float32Array(3 * 16);
  for (let i = 0; i < 3; i++) local.set(identity(), i * 16);
  local[16 + 14] = 50;
  local[32 + 14] = -10;
  const rig: RigData = {
    names: ['Root', 'Pelvis', 'Thigh'],
    parents: Int16Array.from([-1, 0, 1]),
    local,
  };
  return new ActorSkeleton(rig, undefined);
}

/** A placement at (x, y, 0). */
function at(x: number, y: number): Float32Array {
  const m = identity();
  m[12] = x;
  m[13] = y;
  return m;
}

describe('a corpse pose', () => {
  it('keeps the nodes its ragdoll placed, in the world, and lies so again elsewhere placed', () => {
    const pose = new ActorPose(skeleton());
    // Its ragdoll laid the pelvis down on its side at 10 up, the thigh following it.
    const lying = identity();
    lying.set([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 10, 1]);
    pose.place(new Map([[1, lying]]));
    const kept = corpsePose(pose, at(100, 0), true);
    expect(kept.nodes).toEqual(['Pelvis']);
    expect(kept.worlds[12]).toBe(100);
    expect(kept.worlds[14]).toBe(10);

    // Placed again 30 units further on: its pelvis lies where it lay in the world.
    const again = new ActorPose(skeleton());
    expect(placeCorpsePose(again, at(130, 0), kept)).toBe(true);
    expect(again.worlds[16 + 12]).toBeCloseTo(-30);
    expect(again.worlds[16 + 14]).toBeCloseTo(10);
    // The thigh hangs off it as before: 10 along the pelvis's own down (here the world's y).
    expect(again.worlds[32 + 13]).toBeCloseTo(pose.worlds[32 + 13] ?? Number.NaN);
  });

  it('does not fit a skeleton without its nodes', () => {
    const pose = new ActorPose(skeleton());
    const kept = { nodes: ['Tail'], worlds: identity(), resting: true };
    expect(placeCorpsePose(pose, at(0, 0), kept)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { transformPoint } from '../../render/math.ts';
import { cameraWorld, facingWorld, heldAnchor, spreadOver } from './effect-placement.ts';

const translation = (x: number, y: number, z: number, scale = 1): Float32Array =>
  new Float32Array([scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, x, y, z, 1]);

describe('a Face Target art', () => {
  it('turns its +Y from where it hangs towards the reference it faces', () => {
    const world = facingWorld(translation(100, 0, 0), [50, 0, 0]);
    // Its forward (+Y, 10 units out) now lies towards -X of where it hangs.
    const ahead = transformPoint(world, [0, 10, 0]);
    expect(ahead[0]).toBeCloseTo(90, 4);
    expect(ahead[1]).toBeCloseTo(0, 4);
    expect(ahead[2]).toBeCloseTo(0, 4);
    // Its up stays world up on level ground, and it keeps its place.
    const up = transformPoint(world, [0, 0, 10]);
    expect(up[2]).toBeCloseTo(10, 4);
    expect([world[12], world[13], world[14]]).toEqual([100, 0, 0]);
  });

  it('pitches towards a reference above it and keeps its scale', () => {
    const world = facingWorld(translation(0, 0, 0, 2), [0, 100, 100]);
    const ahead = transformPoint(world, [0, 1, 0]);
    expect(ahead[1]).toBeCloseTo(Math.SQRT2, 4);
    expect(ahead[2]).toBeCloseTo(Math.SQRT2, 4);
  });

  it('stays as it hangs when what it faces is where it is', () => {
    const at = translation(5, 6, 7);
    expect([...facingWorld(at, [5, 6, 7])]).toEqual([...at]);
  });
});

describe('an Attach To Camera art', () => {
  it('hangs at the camera, unturned without Inherit Rotation', () => {
    const world = cameraWorld([10, 20, 30], [1, 0, 0], false);
    expect([...world]).toEqual([...translation(10, 20, 30)]);
  });

  it('turns its +Y along the camera’s forward with Inherit Rotation', () => {
    const world = cameraWorld([10, 20, 30], [1, 0, 0], true);
    const ahead = transformPoint(world, [0, 5, 0]);
    expect(ahead[0]).toBeCloseTo(15, 4);
    expect(ahead[1]).toBeCloseTo(20, 4);
    expect(ahead[2]).toBeCloseTo(30, 4);
  });
});

describe('art on a held weapon', () => {
  it('hangs at the pose node the weapon’s root is held on', () => {
    const pose = {};
    expect(heldAnchor({ instances: [{ pose, poseNodes: Int16Array.from([3, 7, 8]) }] })).toBe(3);
  });

  it('follows an actor’s bones instead, and stands at an object’s origin', () => {
    const pose = {};
    expect(heldAnchor({ pose, instances: [{ pose, poseNodes: Int16Array.from([3]) }] })).toBe(
      undefined,
    );
    expect(heldAnchor({ instances: [{}] })).toBe(undefined);
  });
});

describe('addon models among the bones', () => {
  it('spreads its picks evenly along the bones', () => {
    expect(spreadOver([10, 11, 12, 13, 14, 15, 16, 17], 4)).toEqual([11, 13, 15, 17]);
    expect(spreadOver([4, 5], 3)).toEqual([4, 5, 5]);
    expect(spreadOver([], 2)).toEqual([-1, -1]);
  });
});

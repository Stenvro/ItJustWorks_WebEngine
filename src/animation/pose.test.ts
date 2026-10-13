import { describe, expect, it } from 'vitest';
import { addPose, blendPoses, PoseAccumulator } from './pose.ts';

const S = Math.SQRT1_2;
/** One bone: translation, quaternion (xyzw), scale. */
const bone = (x: number, q: readonly number[], s = 1): number[] => [x, 0, 0, ...q, s, s, s];
const IDENTITY = [0, 0, 0, 1];
const TURN_Z = [0, 0, S, S]; // 90° about z
const round = (values: Float32Array): number[] =>
  Array.from(values, (v) => Math.round(v * 1000) / 1000);

describe('poses', () => {
  it('blends weighted poses per bone, quaternions aligned and normalised', () => {
    const acc = new PoseAccumulator(2);
    const a = Float32Array.from([...bone(0, IDENTITY), ...bone(10, IDENTITY)]);
    // The second pose's turn is stored negated: the same turn.
    const b = Float32Array.from([
      ...bone(
        10,
        TURN_Z.map((v) => -v),
      ),
      ...bone(20, IDENTITY),
    ]);
    acc.add(a, 1);
    acc.add(b, 1, Float32Array.of(1, 0));
    const out = new Float32Array(20);
    const fallback = Float32Array.from([...bone(-1, IDENTITY), ...bone(-1, IDENTITY)]);
    acc.finish(out, fallback);
    // Bone 0: halfway (45° about z); bone 1 only from the first pose.
    const half = Math.sin(Math.PI / 8);
    expect(round(out.subarray(0, 10))).toEqual(
      round(Float32Array.from(bone(5, [0, 0, half, Math.cos(Math.PI / 8)]))),
    );
    expect(round(out.subarray(10, 20))).toEqual(round(Float32Array.from(bone(10, IDENTITY))));
    // Bones nothing reached keep the fallback.
    const empty = new PoseAccumulator(2);
    empty.finish(out, fallback);
    expect(out[0]).toBe(-1);
  });

  it('blends two poses by a fraction', () => {
    const out = new Float32Array(10);
    blendPoses(
      Float32Array.from(bone(0, IDENTITY)),
      Float32Array.from(bone(4, TURN_Z, 3)),
      0.5,
      out,
    );
    expect(out[0]).toBeCloseTo(2);
    expect(out[7]).toBeCloseTo(2);
    expect(out[5]).toBeCloseTo(Math.sin(Math.PI / 8));
  });

  it('lays an additive pose on top', () => {
    const base = Float32Array.from(bone(1, TURN_Z));
    addPose(base, Float32Array.from(bone(2, TURN_Z, 2)), 1);
    // 90° then 90° more about z: 180°.
    expect(round(base)).toEqual(round(Float32Array.from(bone(3, [0, 0, 1, 0], 2))));
  });
});

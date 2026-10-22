import { describe, expect, it } from 'vitest';
import { PackfileBuilder } from '../../../tests/helpers/hkx-builder.ts';
import { readAnimationContainer, readRagdollMapping, TRANSFORM_FLOATS } from './animation.ts';
import { Packfile } from './packfile.ts';

/** Writes the bytes of spline-compressed blocks. */
class BlockWriter {
  readonly bytes: number[] = [];

  u8(...values: number[]): this {
    this.bytes.push(...values);
    return this;
  }

  u16(...values: number[]): this {
    for (const value of values) this.bytes.push(value & 0xff, (value >> 8) & 0xff);
    return this;
  }

  f32(...values: number[]): this {
    const view = new DataView(new ArrayBuffer(4));
    for (const value of values) {
      view.setFloat32(0, value, true);
      this.bytes.push(...new Uint8Array(view.buffer));
    }
    return this;
  }

  align(to: number): this {
    while (this.bytes.length % to !== 0) this.bytes.push(0);
    return this;
  }

  /** A linear curve over a block of 30 frames: count 1, degree 1, knots 0 0 30 30. */
  linear(): this {
    return this.u16(1).u8(1, 0, 0, 30, 30);
  }

  /** THREECOMP40: three 12-bit components, the largest one's index and sign. */
  comp40(q: readonly number[]): this {
    const { missing, stored, negative } = largest(q);
    const field = (v: number): number => Math.round(v / (Math.SQRT1_2 / 2047)) + 2047;
    let bits = 0;
    stored.forEach((v, i) => (bits += field(v) * 2 ** (12 * i)));
    bits += missing * 2 ** 36 + (negative ? 2 ** 38 : 0);
    for (let i = 0; i < 5; i++) this.bytes.push(Math.floor(bits / 2 ** (8 * i)) % 256);
    return this;
  }

  /** THREECOMP48: three 15-bit components; the index in the top bits of x and y, sign in z. */
  comp48(q: readonly number[]): this {
    const { missing, stored, negative } = largest(q);
    const field = (v: number): number => Math.round(v / (Math.SQRT1_2 / 16383)) + 16383;
    const [x = 0, y = 0, z = 0] = stored.map(field);
    return this.u16(
      x | ((missing & 1) << 15),
      y | ((missing >> 1) << 15),
      z | (negative ? 0x8000 : 0),
    );
  }
}

function largest(q: readonly number[]): {
  missing: number;
  stored: number[];
  negative: boolean;
} {
  let missing = 0;
  q.forEach((v, i) => {
    if (Math.abs(v) > Math.abs(q[missing] ?? 0)) missing = i;
  });
  return {
    missing,
    stored: q.filter((_, i) => i !== missing),
    negative: (q[missing] ?? 0) < 0,
  };
}

const turnZ = (degrees: number): number[] => {
  const half = (degrees * Math.PI) / 360;
  return [0, 0, Math.sin(half), Math.cos(half)];
};

/**
 * Two blocks of 30 frames (one second each) over three transform tracks and one float track.
 * Block 0: track 0 has a static x and a curve on y (8 bits, 0 → 10) and a THREECOMP40 curve
 * from no turn to 60° about z; track 1 static everything (THREECOMP48 rotation); track 2
 * nothing (identity); the float rises 0 → 1 (16 bits). Block 1: track 0 static (THREECOMP40),
 * track 1 a POLAR32 rotation, track 2 a NaN position, the float static 0.25.
 */
function blocks(): { data: number[]; offsets: number[]; floatOffsets: number[] } {
  const w = new BlockWriter();
  // Block 0: masks (quantizations, position, rotation, scale), the float mask, align 4.
  w.u8(0x04, 0x21, 0xf0, 0x00);
  w.u8(0x08, 0x07, 0x0f, 0x07);
  w.u8(0x00, 0x00, 0x00, 0x00);
  w.u8(0x12).align(4);
  // Track 0: position curve, then x static, y range, control points; rotation curve.
  w.linear().align(4).f32(5, 0, 10).u8(0, 255).align(4);
  w.linear().comp40([0, 0, 0, 1]).comp40(turnZ(60)).align(4);
  // Track 1: static position, rotation (aligned to 2), scale.
  w.f32(1, 2, 3).align(2).comp48(turnZ(-90)).align(4).f32(2, 2, 2);
  // Track 2: nothing stored.
  const float0 = w.bytes.length;
  w.linear().align(4).f32(0, 1).u16(0, 0xffff).align(4);
  const block1 = w.align(16).bytes.length;
  w.u8(0x04, 0x07, 0x0f, 0x00);
  w.u8(0x00, 0x00, 0x0f, 0x00);
  w.u8(0x00, 0x01, 0x00, 0x00);
  w.u8(0x03).align(4);
  w.f32(7, 8, 9).comp40(turnZ(30)).align(4);
  // POLAR32 of 60° about z: w = r, (x, y, z) at phi = 0 is (0, 0, magnitude).
  w.u16(0, Math.round(1023 * Math.sqrt(1 - Math.cos(Math.PI / 6))) << 2).align(4);
  w.f32(Number.NaN);
  const float1 = w.bytes.length - block1;
  w.f32(0.25).align(16);
  return { data: w.bytes, offsets: [0, block1], floatOffsets: [float0, float1] };
}

function buildClip(): Uint8Array {
  const b = new PackfileBuilder();
  const container = b.object('hkaAnimationContainer', 64);
  const skeleton = b.object('hkaSkeleton', 104);
  const animation = b.object('hkaSplineCompressedAnimation', 176);
  const binding = b.object('hkaAnimationBinding', 72);
  const motion = b.object('hkaDefaultAnimatedReferenceFrame', 72);
  b.pointer(b.array(container + 16, 8, 1), skeleton);
  b.pointer(b.array(container + 48, 8, 1), binding);
  // Skeleton: three bones under the first, reference pose, one float slot.
  b.string(skeleton + 16, 'NPC Root [Root]');
  const parents = b.array(skeleton + 24, 2, 3);
  b.i16(parents, -1)
    .i16(parents + 2, 0)
    .i16(parents + 4, 0);
  const bones = b.array(skeleton + 40, 16, 3);
  ['NPC Root [Root]', 'Weapon', 'Shield'].forEach((name, i) => b.string(bones + i * 16, name));
  b.u8(bones + 16 + 8, 1);
  const pose = b.array(skeleton + 56, 48, 3);
  for (let i = 0; i < 3; i++)
    b.f32(pose + i * 48, i)
      .f32(pose + i * 48 + 28, 1)
      .f32(pose + i * 48 + 32, 1);
  b.f32(b.array(skeleton + 72, 4, 1), 1);
  b.string(b.array(skeleton + 88, 8, 1), 'hkVis:Weapon');
  // Animation header.
  const { data, offsets, floatOffsets } = blocks();
  b.i32(animation + 16, 5)
    .f32(animation + 20, 2)
    .i32(animation + 24, 3)
    .i32(animation + 28, 1);
  b.pointer(animation + 32, motion);
  const track = b.array(animation + 40, 24, 1);
  const notes = b.array(track + 8, 16, 2);
  b.f32(notes, 1.5).string(notes + 8, 'FootRight');
  b.f32(notes + 16, 0.25).string(notes + 24, 'FootLeft');
  b.i32(animation + 56, 61)
    .i32(animation + 60, 2)
    .i32(animation + 64, 31);
  b.f32(animation + 72, 1)
    .f32(animation + 76, 1)
    .f32(animation + 80, 1 / 30);
  const blockOffsets = b.array(animation + 88, 4, 2);
  const floatBlockOffsets = b.array(animation + 104, 4, 2);
  offsets.forEach((offset, i) => b.i32(blockOffsets + i * 4, offset));
  floatOffsets.forEach((offset, i) => b.i32(floatBlockOffsets + i * 4, offset));
  const bytes = b.array(animation + 152, 1, data.length);
  data.forEach((byte, i) => b.u8(bytes + i, byte));
  // Binding and root motion.
  b.string(binding + 16, 'NPC Root [Root]').pointer(binding + 24, animation);
  b.i16(b.array(binding + 48, 2, 1), 0);
  b.f32(motion + 24, 1)
    .f32(motion + 36, 1)
    .f32(motion + 48, 2);
  const samples = b.array(motion + 56, 16, 2);
  b.f32(samples + 16 + 4, 250).f32(samples + 16 + 12, 0.5);
  return b.build(container);
}

describe('Havok animations', () => {
  const container = readAnimationContainer(Packfile.parse(buildClip()));
  const binding = container.bindings[0];
  const animation = binding?.animation;
  if (!binding || !animation) throw new Error('no binding');

  /** The pose at a time over a buffer prefilled with a marker the unusable track keeps. */
  const sample = (time: number): { pose: number[][]; floats: number[] } => {
    const out = new Float32Array(3 * TRANSFORM_FLOATS).fill(-1);
    const floats = new Float32Array(1);
    animation.sample(time, out, floats);
    const pose = [0, 1, 2].map((t) =>
      Array.from(out.subarray(t * TRANSFORM_FLOATS, (t + 1) * TRANSFORM_FLOATS)),
    );
    return { pose, floats: Array.from(floats) };
  };
  const close = (actual: readonly number[] | undefined, expected: readonly number[]): void => {
    expect(actual?.length).toBe(expected.length);
    expected.forEach((value, i) => {
      expect(actual?.[i]).toBeCloseTo(value, 2);
    });
  };

  it('reads the skeleton: bones, parents, reference pose and float slots', () => {
    const skeleton = container.skeletons[0];
    expect(skeleton?.bones.map((bone) => bone.name)).toEqual([
      'NPC Root [Root]',
      'Weapon',
      'Shield',
    ]);
    expect(skeleton?.bones[1]?.lockTranslation).toBe(true);
    expect(Array.from(skeleton?.parents ?? [])).toEqual([-1, 0, 0]);
    close(
      Array.from(skeleton?.referencePose.subarray(10, 20) ?? []),
      [1, 0, 0, 0, 0, 0, 1, 1, 0, 0],
    );
    expect(skeleton?.floatSlots).toEqual(['hkVis:Weapon']);
    expect(Array.from(skeleton?.referenceFloats ?? [])).toEqual([1]);
  });

  it('reads the binding, annotations by time and the extracted motion', () => {
    expect(binding.skeletonName).toBe('NPC Root [Root]');
    expect(binding.trackToBone).toBeUndefined();
    expect(Array.from(binding.floatTrackToSlot ?? [])).toEqual([0]);
    expect(binding.additive).toBe(false);
    expect(animation.duration).toBe(2);
    expect([animation.trackCount, animation.floatTrackCount]).toEqual([3, 1]);
    expect(animation.annotations).toEqual([
      { time: 0.25, text: 'FootLeft' },
      { time: 1.5, text: 'FootRight' },
    ]);
    expect(animation.motion?.up).toEqual([0, 0, 1]);
    expect(Array.from(animation.motion?.samples ?? [])).toEqual([0, 0, 0, 0, 0, 250, 0, 0.5]);
  });

  it('evaluates position curves and static components through the block', () => {
    close(sample(0).pose[0]?.slice(0, 3), [5, 0, 0]);
    close(sample(0.5).pose[0]?.slice(0, 3), [5, 5, 0]);
    close(sample(0.999).pose[0]?.slice(0, 3), [5, 9.99, 0]);
    close(sample(0.5).pose[1], [1, 2, 3, ...turnZ(-90), 2, 2, 2]);
  });

  it('blends quaternion curves (THREECOMP40) and keeps them unit length', () => {
    close(sample(0).pose[0]?.slice(3, 7), turnZ(0));
    close(sample(0.5).pose[0]?.slice(3, 7), turnZ(30));
    close(sample(0.999).pose[0]?.slice(3, 7), turnZ(60));
    close(sample(0.5).pose[0]?.slice(7), [1, 1, 1]);
  });

  it('switches to the next block and reads its static tracks (THREECOMP40, POLAR32)', () => {
    const { pose } = sample(1.5);
    close(pose[0], [7, 8, 9, ...turnZ(30), 1, 1, 1]);
    close(pose[1]?.slice(0, 7), [0, 0, 0, ...turnZ(60)]);
    expect(sample(5).pose[0]?.[0]).toBeCloseTo(7);
  });

  it('leaves tracks with unusable data alone, block by block', () => {
    close(sample(0.5).pose[2], [0, 0, 0, 0, 0, 0, 1, 1, 1, 1]);
    expect(sample(1.5).pose[2]).toEqual(new Array(TRANSFORM_FLOATS).fill(-1));
  });

  it('evaluates float tracks: a 16-bit curve, then a static value', () => {
    close(sample(0.5).floats, [0.5]);
    close(sample(1.5).floats, [0.25]);
  });
});

describe('ragdoll mapping', () => {
  /** A skeleton of named bones at an object (hkaSkeleton: name, parents, bones, pose). */
  const skeleton = (b: PackfileBuilder, name: string, bones: string[]): number => {
    const at = b.object('hkaSkeleton', 104);
    b.string(at + 16, name);
    const parents = b.array(at + 24, 2, bones.length);
    bones.forEach((_, i) => b.i16(parents + i * 2, i === 0 ? -1 : 0));
    const list = b.array(at + 40, 16, bones.length);
    bones.forEach((bone, i) => b.string(list + i * 16, bone));
    b.array(at + 56, 48, bones.length);
    return at;
  };

  it("reads the mapper from the ragdoll skeleton onto the animation skeleton's bones", () => {
    const b = new PackfileBuilder();
    const container = b.object('hkaAnimationContainer', 64);
    const animation = skeleton(b, 'NPC Root [Root]', ['NPC Root [Root]', 'NPC COM [COM ]', 'X']);
    const ragdoll = skeleton(b, 'Ragdoll_COM', ['Ragdoll_COM01', 'Ragdoll_X01']);
    const skeletons = b.array(container + 16, 8, 2);
    b.pointer(skeletons, animation).pointer(skeletons + 8, ragdoll);
    // Two mappers, as the files have: animation → ragdoll (left out) and ragdoll → animation.
    for (const [a, c, pairs] of [
      [animation, ragdoll, [[1, 0]]],
      [ragdoll, animation, [[0, 1]]],
    ] as const) {
      const mapper = b.object('hkaSkeletonMapper', 128);
      b.pointer(mapper + 16, a).pointer(mapper + 24, c);
      const simple = b.array(mapper + 32, 64, pairs.length);
      pairs.forEach(([boneA, boneB], i) =>
        b.i16(simple + i * 64, boneA).i16(simple + i * 64 + 2, boneB),
      );
    }
    const pack = Packfile.parse(b.build(container));
    const mapping = readRagdollMapping(pack, 'NPC Root [Root]');
    expect(mapping?.ragdoll.name).toBe('Ragdoll_COM');
    expect(Array.from(mapping?.bones ?? [])).toEqual([1, -1]);
    expect(readRagdollMapping(pack, 'no such skeleton')).toBeUndefined();
  });
});

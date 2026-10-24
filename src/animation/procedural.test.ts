import { describe, expect, it } from 'vitest';
import { TRANSFORM_FLOATS } from '../formats/hkx/animation.ts';
import type { FootIkSetup } from '../formats/hkx/behavior.ts';
import {
  directAt,
  footIk,
  footIkState,
  gainStep,
  lookAt,
  lookAtState,
  ModelSpace,
  solveLeg,
  twist,
  type DirectAtValues,
  type FootIkGainValues,
  type LookAtValues,
} from './procedural.ts';

const DEG = Math.PI / 180;

/** A bone-local pose of identity turns at the given translations. */
function pose(translations: readonly (readonly [number, number, number])[]): Float32Array {
  const out = new Float32Array(translations.length * TRANSFORM_FLOATS);
  translations.forEach((t, bone) => {
    out.set([t[0], t[1], t[2], 0, 0, 0, 1, 1, 1, 1], bone * TRANSFORM_FLOATS);
  });
  return out;
}

/** The heading (right +, degrees) of a bone's forward (its y) in model space. */
function heading(space: ModelSpace, bone: number): number {
  const [x, y, z, w] = space.rotation(bone);
  return Math.atan2(2 * (x * y - z * w), 1 - 2 * (x * x + z * z)) / DEG;
}

describe('look-at (BSLookAtModifier)', () => {
  // Root, neck, head, eye: the neck limited to 20°, the head to 30°, the eye to 70°.
  const parents = Int16Array.from([-1, 0, 1, 2]);
  const local = (): Float32Array =>
    pose([
      [0, 0, 0],
      [0, 0, 100],
      [0, 0, 10],
      [0, 5, 5],
    ]);
  const bone = (index: number, limit: number, gain = 1) => ({
    index,
    forwardAxis: [0, 1, 0] as const,
    limit: limit * DEG,
    onGain: gain,
    offGain: gain,
    enabled: true,
  });
  const values = (gain = 1): LookAtValues => ({
    bones: [bone(1, 20, gain), bone(2, 30, gain)],
    eyeBones: [bone(3, 70, gain)],
    limit: 85 * DEG,
    threshold: 10 * DEG,
    continueOutsideLimit: true,
    onGain: gain,
    offGain: gain,
    useBoneGains: true,
  });
  // Far to the right of the eyes, at their height: 80° off the character's forward.
  const target = [1000 * Math.sin(80 * DEG), 1000 * Math.cos(80 * DEG), 115] as const;

  it('turns each bone within its own limit, the eyes taking the rest', () => {
    const space = new ModelSpace(parents);
    const state = lookAtState(values());
    const p = local();
    space.update(p);
    const result = lookAt(values(), state, p, space, target, true, 1 / 30, true);
    space.update(p);
    expect(heading(space, 1)).toBeCloseTo(20, 1);
    expect(heading(space, 2)).toBeCloseTo(50, 1);
    // The eyes turn the remaining 30° (seen from the eyes, a little more).
    expect(result.eyes?.heading ?? 0).toBeGreaterThan(29 * DEG);
    expect(result.eyes?.heading ?? 0).toBeLessThan(31 * DEG);
    expect(result.outside).toBe(false);
  });

  it('eases the look on by its gain, frame-rate independent', () => {
    const space = new ModelSpace(parents);
    const state = lookAtState(values(0.5));
    const p = local();
    space.update(p);
    lookAt(values(0.5), state, p, space, target, true, 1 / 30, true);
    space.update(p);
    // Half way to the neck's 20° in one 30 Hz step (a normalised lerp: a little more).
    expect(heading(space, 1)).toBeGreaterThan(9.5);
    expect(heading(space, 1)).toBeLessThan(10.5);
    expect(gainStep(0.5, 1 / 30)).toBeCloseTo(0.5);
    expect(gainStep(0.5, 2 / 30)).toBeCloseTo(0.75);
    expect(gainStep(1, 0.001)).toBe(1);
  });

  it('eases back off when it stops looking', () => {
    const space = new ModelSpace(parents);
    const state = lookAtState(values());
    let p = local();
    space.update(p);
    lookAt(values(), state, p, space, target, true, 1 / 30, true);
    p = local();
    space.update(p);
    lookAt(values(), state, p, space, target, false, 1 / 30, true);
    space.update(p);
    expect(heading(space, 2)).toBeCloseTo(0, 3);
  });

  it('marks a target behind as outside its limits, inside again within the threshold', () => {
    const space = new ModelSpace(parents);
    const state = lookAtState(values());
    const behind = [0, -1000, 115] as const;
    let p = local();
    space.update(p);
    const out = lookAt(values(), state, p, space, behind, true, 1 / 30, true);
    expect(out.outside).toBe(true);
    expect(out.wentOutside).toBe(true);
    // At 80° (within 85° but not 75°) it stays outside; at 60° it is back inside.
    p = local();
    space.update(p);
    expect(lookAt(values(), state, p, space, target, true, 1 / 30, true).outside).toBe(true);
    const near = [1000 * Math.sin(60 * DEG), 1000 * Math.cos(60 * DEG), 115] as const;
    p = local();
    space.update(p);
    expect(lookAt(values(), state, p, space, near, true, 1 / 30, true).outside).toBe(false);
  });
});

describe('twist (hkbTwistModifier)', () => {
  const parents = Int16Array.from([-1, 0, 1, 2]);
  const local = (): Float32Array =>
    pose([
      [0, 0, 0],
      [0, 0, 10],
      [0, 0, 10],
      [0, 0, 10],
    ]);

  it('shares the angle equally along the chain (linear)', () => {
    const space = new ModelSpace(parents);
    const p = local();
    space.update(p);
    twist(
      {
        axis: [0, 0, 1],
        angle: -90 * DEG,
        startBone: 1,
        endBone: 3,
        setAngleMethod: 0,
        rotationAxisCoordinates: 0,
        isAdditive: true,
      },
      p,
      space,
      local(),
    );
    space.update(p);
    expect(heading(space, 1)).toBeCloseTo(30, 3);
    expect(heading(space, 2)).toBeCloseTo(60, 3);
    expect(heading(space, 3)).toBeCloseTo(90, 3);
  });

  it('grows the shares along the chain (ramped)', () => {
    const space = new ModelSpace(parents);
    const p = local();
    space.update(p);
    twist(
      {
        axis: [0, 0, 1],
        angle: -60 * DEG,
        startBone: 1,
        endBone: 3,
        setAngleMethod: 1,
        rotationAxisCoordinates: 0,
        isAdditive: true,
      },
      p,
      space,
      local(),
    );
    space.update(p);
    // Shares 1/6, 2/6, 3/6 of 60°: 10, 30, 60 in total.
    expect(heading(space, 1)).toBeCloseTo(10, 3);
    expect(heading(space, 2)).toBeCloseTo(30, 3);
    expect(heading(space, 3)).toBeCloseTo(60, 3);
  });
});

describe('direct-at (BSDirectAtModifier)', () => {
  // Root, spine, chest (the source: 20 ahead of it, 100 up).
  const parents = Int16Array.from([-1, 0, 1]);
  const local = (): Float32Array =>
    pose([
      [0, 0, 0],
      [0, 0, 80],
      [0, 20, 20],
    ]);
  const values = (over: Partial<DirectAtValues> = {}): DirectAtValues => ({
    sourceBone: 2,
    startBone: 1,
    endBone: 2,
    limitHeading: 90 * DEG,
    limitPitch: 90 * DEG,
    offsetHeading: 0,
    offsetPitch: 0,
    onGain: 1,
    offGain: 1,
    ...over,
  });
  const run = (v: DirectAtValues, target: readonly [number, number, number] | undefined) => {
    const space = new ModelSpace(parents);
    const p = local();
    space.update(p);
    return directAt(v, { heading: 0, pitch: 0 }, p, space, target, true, 1 / 30, true);
  };

  it('turns by the way from its source bone to the target', () => {
    // The chest at (0, 20, 100): a target 100 to its right and 100 ahead is 45° right.
    const turned = run(values(), [100, 120, 100]);
    expect(turned.heading / DEG).toBeCloseTo(45, 3);
    expect(turned.pitch / DEG).toBeCloseTo(0, 3);
  });

  it("measures from the character's origin without a source bone, offsets after the limits", () => {
    // Block anticipation: no source bone, limits 60° and 30°, offsets 20° and -20°.
    const v = values({
      sourceBone: -1,
      limitHeading: 60 * DEG,
      limitPitch: 30 * DEG,
      offsetHeading: 20 * DEG,
      offsetPitch: -20 * DEG,
    });
    // From the origin: 90° right, 45° up; clamped to 60° and 30°, then offset.
    const turned = run(v, [100, 0, 100]);
    expect(turned.heading / DEG).toBeCloseTo(80, 3);
    expect(turned.pitch / DEG).toBeCloseTo(10, 3);
  });

  it('eases off to none without a target, snapping the last of it', () => {
    const space = new ModelSpace(parents);
    const p = local();
    space.update(p);
    const state = { heading: 0.005, pitch: 0.2 };
    const turned = directAt(
      values({ offGain: 0.5 }),
      state,
      p,
      space,
      undefined,
      true,
      1 / 30,
      true,
    );
    expect(turned.heading).toBe(0);
    expect(turned.pitch).toBeCloseTo(0.1, 6);
  });
});

describe('foot IK', () => {
  // Root, pelvis at 70; each leg: hip 10 to the side, knee 32 down (a little forward), ankle
  // 32 down: the ankle 6 above the ground at rest.
  const parents = Int16Array.from([-1, 0, 1, 2, 3, 1, 5, 6]);
  const local = (): Float32Array =>
    pose([
      [0, 0, 0],
      [0, 0, 70],
      [-10, 0, 0],
      [0, 2, -32],
      [0, -2, -32],
      [10, 0, 0],
      [0, 2, -32],
      [0, -2, -32],
    ]);
  const leg = (hip: number) => ({
    hipIndex: hip,
    kneeIndex: hip + 1,
    ankleIndex: hip + 2,
    kneeAxis: [1, 0, 0] as const,
    footEnd: [0, 0, 0] as const,
    footPlantedAnkleHeight: 6,
    footRaisedAnkleHeight: 16,
    maxAnkleHeight: 34,
    minAnkleHeight: -24,
    maxKneeAngleDegrees: 179,
    minKneeAngleDegrees: 5,
    maxAnkleAngleDegrees: 30,
  });
  const setup: FootIkSetup = {
    legs: [leg(2), leg(5)],
    raycastDistanceUp: 40,
    raycastDistanceDown: 32,
    originalGroundHeightMS: 0,
    verticalOffset: 0,
    collisionFilterInfo: 3,
    forwardAlignFraction: 1,
    sidewaysAlignFraction: 0,
    sidewaysSampleWidth: 0.2,
    useTrackData: false,
    lockFeetWhenPlanted: true,
    useCharacterUpVector: false,
  };
  const gains: FootIkGainValues = {
    onOffGain: 1,
    groundAscendingGain: 1,
    groundDescendingGain: 1,
    footPlantedGain: 1,
    footRaisedGain: 1,
    worldFromModelFeedbackGain: 1,
    errorUpDownBias: 1,
    alignWorldFromModelGain: 0,
    ankleOrientationGain: 1,
  };
  // Ground rising to the right: 0.3 units up per unit.
  const slope = (from: readonly [number, number, number], length: number) => {
    const z = 0.3 * from[0];
    if (z > from[2] || z < from[2] - length) return undefined;
    const n = Math.hypot(0.3, 1);
    return { height: z, normal: [-0.3 / n, 0, 1 / n] as const };
  };

  it('sets each foot on its ground on a slope, the body lowered to the lower one', () => {
    const space = new ModelSpace(parents);
    const p = local();
    space.update(p);
    const state = footIkState(2);
    const result = footIk(setup, gains, true, state, p, space, slope, 1 / 30, true);
    space.update(p);
    const left = space.position(4);
    const right = space.position(7);
    // Each ankle 6 above its own ground.
    expect(left[2] - 0.3 * left[0]).toBeCloseTo(6, 0);
    expect(right[2] - 0.3 * right[0]).toBeCloseTo(6, 0);
    // The body went down as far as the left (lower) foot's ground lies below the model's.
    expect(result.offset).toBeCloseTo(-3, 1);
    expect(space.position(1)[2]).toBeCloseTo(67, 1);
    // The legs keep their lengths.
    const length = (a: number, b: number): number => {
      const [ax, ay, az] = space.position(a);
      const [bx, by, bz] = space.position(b);
      return Math.hypot(ax - bx, ay - by, az - bz);
    };
    expect(length(2, 3)).toBeCloseTo(Math.hypot(2, 32), 3);
    expect(length(6, 7)).toBeCloseTo(Math.hypot(2, 32), 3);
    expect(result.legs.map((found) => found.hit)).toEqual([true, true]);
  });

  it('eases off without changing what it found', () => {
    const space = new ModelSpace(parents);
    const state = footIkState(2);
    let p = local();
    space.update(p);
    footIk(setup, gains, true, state, p, space, slope, 1 / 30, true);
    p = local();
    space.update(p);
    const half = { ...gains, onOffGain: 0.5 };
    footIk(setup, half, false, state, p, space, slope, 1 / 30, true);
    expect(state.weight).toBeCloseTo(0.5);
    expect(state.offset).toBeCloseTo(-3, 1);
  });

  it('bends a leg held straight, or a little past it, forward to the knee limit', () => {
    // The people's legs: the knee's interior angle at most 165°. A clip's leg straight (the knee
    // on the line) or 1° past straight (the knee a little behind it) bends forward, the hinge's
    // way, as a bent one does: the knee ends in front of the line from hip to ankle.
    for (const knee of [0, -0.3]) {
      const p = pose([
        [0, 0, 0],
        [0, 0, 70],
        [-10, 0, 0],
        [0, knee, -32],
        [0, -knee, -32],
      ]);
      const space = new ModelSpace(Int16Array.from([-1, 0, 1, 2, 3]));
      space.update(p);
      const straight = { ...leg(2), maxKneeAngleDegrees: 165 };
      solveLeg(straight, space.position(4), p, space);
      space.update(p);
      const [, hipY, hipZ] = space.position(2);
      const [, kneeY, kneeZ] = space.position(3);
      const [, ankleY, ankleZ] = space.position(4);
      // The line from hip to ankle at the knee's height, and the knee ahead of it.
      const along = (kneeZ - hipZ) / (ankleZ - hipZ);
      expect(kneeY - (hipY + along * (ankleY - hipY))).toBeGreaterThan(3);
      const up = [0, hipY - kneeY, hipZ - kneeZ] as const;
      const down = [0, ankleY - kneeY, ankleZ - kneeZ] as const;
      const interior =
        Math.acos((up[1] * down[1] + up[2] * down[2]) / (Math.hypot(...up) * Math.hypot(...down))) /
        DEG;
      // The straight one to the limit; the one past straight turns by the limit less its
      // unsigned angle (178.9°), so it ends twice its 1.1° past straight short of the limit.
      expect(interior).toBeCloseTo(knee === 0 ? 165 : 167.2, 0);
    }
  });
});

describe('model space', () => {
  it('writes a model-space turn back as the bone-local one', () => {
    const parents = Int16Array.from([-1, 0, 1]);
    const p = pose([
      [0, 0, 0],
      [0, 0, 10],
      [0, 0, 10],
    ]);
    const space = new ModelSpace(parents);
    space.update(p);
    const quarter = [0, 0, Math.sin(Math.PI / 4), Math.cos(Math.PI / 4)];
    space.setRotation(1, quarter, p);
    space.setRotation(2, quarter, p);
    // The child's own turn is none: its parent's turn carries it.
    expect(p[2 * TRANSFORM_FLOATS + 6]).toBeCloseTo(1);
    expect(space.position(2)[2]).toBeCloseTo(20);
  });
});
